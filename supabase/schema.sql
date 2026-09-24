-- ============================================================
--  ImmoFamille — Schéma Supabase
--  À exécuter UNE FOIS dans : Supabase > SQL Editor > New query
--
--  ⚠️ AVANT d'exécuter : remplacez tout en bas du fichier
--     VOTRE_EMAIL / VOTRE_NOM / VOTRE_PRENOM par vos informations.
--     C'est ce compte qui sera l'administrateur.
--
--  Principe :
--   - Un proche remplit nom / prénom / e-mail  → demande « en_attente »
--   - L'admin accepte ou refuse depuis l'app  → « approuve » / « refuse »
--   - Maximum 5 membres approuvés (admin compris), vérifié par la base
--   - Seuls les membres approuvés voient et modifient les biens
-- ============================================================

-- ------------------------------------------------------------
-- 1. MEMBRES
-- ------------------------------------------------------------
create table if not exists public.membres (
  id          uuid primary key default gen_random_uuid(),
  email       text not null unique check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  nom         text not null check (char_length(nom)    between 1 and 80),
  prenom      text not null check (char_length(prenom) between 1 and 80),
  role        text not null default 'membre'     check (role   in ('admin', 'membre')),
  statut      text not null default 'en_attente' check (statut in ('en_attente', 'approuve', 'refuse')),
  created_at  timestamptz not null default now(),
  decided_at  timestamptz
);

-- E-mail de l'utilisateur connecté (vérifié par le lien magique)
create or replace function public.email_courant()
returns text language sql stable as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''))
$$;

create or replace function public.est_membre()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.membres
    where email = public.email_courant() and statut = 'approuve'
  )
$$;

create or replace function public.est_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.membres
    where email = public.email_courant() and statut = 'approuve' and role = 'admin'
  )
$$;

-- Règles métier : limite de 5 membres, admin intouchable
create or replace function public.membres_verif()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Sérialise les validations pour ne jamais dépasser la limite
  perform pg_advisory_xact_lock(hashtext('immofamille_membres'));

  if tg_op = 'UPDATE' then
    if new.email <> old.email or new.role <> old.role then
      raise exception 'Modification non autorisée.';
    end if;
    if old.role = 'admin' and new.statut <> 'approuve' then
      raise exception 'L''administrateur ne peut pas être retiré.';
    end if;
  end if;

  if new.statut = 'approuve' and (tg_op = 'INSERT' or old.statut <> 'approuve') then
    if (select count(*) from public.membres where statut = 'approuve' and id <> new.id) >= 5 then
      raise exception 'Limite atteinte : 5 membres maximum (administrateur compris).';
    end if;
  end if;

  if tg_op = 'UPDATE' and new.statut <> old.statut then
    new.decided_at := now();
  end if;

  return new;
end $$;

drop trigger if exists membres_verif on public.membres;
create trigger membres_verif
  before insert or update on public.membres
  for each row execute function public.membres_verif();

alter table public.membres enable row level security;

drop policy if exists membres_lecture on public.membres;
create policy membres_lecture on public.membres
  for select to authenticated
  using (email = public.email_courant() or public.est_admin());

drop policy if exists membres_decision on public.membres;
create policy membres_decision on public.membres
  for update to authenticated
  using (public.est_admin()) with check (public.est_admin());

drop policy if exists membres_suppression on public.membres;
create policy membres_suppression on public.membres
  for delete to authenticated
  using (public.est_admin() and role <> 'admin');

-- Pas de policy INSERT : les demandes passent uniquement par la fonction ci-dessous.

-- ------------------------------------------------------------
-- 2. DEMANDE D'ACCÈS (appelable sans être connecté)
--    Retour : 'envoyee' | 'en_attente' | 'approuve' | 'refuse'
--             | 'complet' | 'trop_de_demandes'
-- ------------------------------------------------------------
create or replace function public.demander_acces(p_nom text, p_prenom text, p_email text)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_email  text := lower(trim(coalesce(p_email, '')));
  v_nom    text := trim(coalesce(p_nom, ''));
  v_prenom text := trim(coalesce(p_prenom, ''));
  v_statut text;
begin
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Adresse e-mail invalide.';
  end if;
  if char_length(v_nom) not between 1 and 80 or char_length(v_prenom) not between 1 and 80 then
    raise exception 'Nom et prénom obligatoires (80 caractères max).';
  end if;

  select statut into v_statut from public.membres where email = v_email;
  if found then
    return v_statut;
  end if;

  if (select count(*) from public.membres where statut = 'approuve') >= 5 then
    return 'complet';
  end if;
  -- Anti-spam : pas plus de 10 demandes en attente en même temps
  if (select count(*) from public.membres where statut = 'en_attente') >= 10 then
    return 'trop_de_demandes';
  end if;

  insert into public.membres (email, nom, prenom) values (v_email, v_nom, v_prenom);
  return 'envoyee';
end $$;

-- Statut d'un e-mail avant d'envoyer le lien de connexion
-- Retour : 'approuve' | 'en_attente' | 'refuse' | 'inconnu'
create or replace function public.statut_email(p_email text)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(
    (select statut from public.membres where email = lower(trim(coalesce(p_email, '')))),
    'inconnu'
  )
$$;

revoke execute on function public.demander_acces(text, text, text) from public;
revoke execute on function public.statut_email(text)                from public;
grant  execute on function public.demander_acces(text, text, text) to anon, authenticated;
grant  execute on function public.statut_email(text)                to anon, authenticated;

-- ------------------------------------------------------------
-- 3. BIENS (partagés entre tous les membres approuvés)
-- ------------------------------------------------------------
create table if not exists public.biens (
  id           text primary key default gen_random_uuid()::text check (id ~ '^[A-Za-z0-9_-]{1,64}$'),
  nom          text not null check (char_length(nom) between 1 and 200),
  type         text not null check (type in ('terrain', 'maison', 'batiment', 'entreprise')),
  description  text check (char_length(description) <= 5000),
  adresse      text check (char_length(adresse) <= 500),
  lat          double precision check (lat between -90 and 90),
  lng          double precision check (lng between -180 and 180),
  legal_docs   jsonb not null default '[]'::jsonb,
  photos       jsonb not null default '[]'::jsonb,   -- [{ name, path }]
  docs         jsonb not null default '[]'::jsonb,   -- [{ name, size, path }]
  created_by   text  not null default public.email_courant(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz
);

alter table public.biens enable row level security;

drop policy if exists biens_lecture on public.biens;
create policy biens_lecture on public.biens
  for select to authenticated using (public.est_membre());

drop policy if exists biens_ajout on public.biens;
create policy biens_ajout on public.biens
  for insert to authenticated with check (public.est_membre());

drop policy if exists biens_modification on public.biens;
create policy biens_modification on public.biens
  for update to authenticated using (public.est_membre()) with check (public.est_membre());

-- Seul l'administrateur peut supprimer un bien
drop policy if exists biens_suppression on public.biens;
create policy biens_suppression on public.biens
  for delete to authenticated using (public.est_admin());

-- ------------------------------------------------------------
-- 4. FICHIERS (photos + documents) — bucket privé
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('fichiers', 'fichiers', false, 10485760)
on conflict (id) do nothing;

drop policy if exists fichiers_lecture on storage.objects;
create policy fichiers_lecture on storage.objects
  for select to authenticated using (bucket_id = 'fichiers' and public.est_membre());

drop policy if exists fichiers_ajout on storage.objects;
create policy fichiers_ajout on storage.objects
  for insert to authenticated with check (bucket_id = 'fichiers' and public.est_membre());

drop policy if exists fichiers_suppression on storage.objects;
create policy fichiers_suppression on storage.objects
  for delete to authenticated using (bucket_id = 'fichiers' and public.est_membre());

-- ------------------------------------------------------------
-- 5. ADMINISTRATEUR  ⚠️ À PERSONNALISER
-- ------------------------------------------------------------
insert into public.membres (email, nom, prenom, role, statut)
values (lower('VOTRE_EMAIL@exemple.com'), 'VOTRE_NOM', 'VOTRE_PRENOM', 'admin', 'approuve')
on conflict (email) do update set role = 'admin', statut = 'approuve';
