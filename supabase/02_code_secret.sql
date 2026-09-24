-- ============================================================
--  ImmoFamille — Double vérification (à exécuter APRÈS schema.sql)
--  Supabase > SQL Editor > New query > coller ce fichier > Run
--
--  Pour accéder aux biens, il faut désormais :
--    1. prouver qu'on possède l'adresse e-mail (code / lien reçu par e-mail)
--    2. donner son CODE SECRET personnel (6 chiffres)
--
--  Première connexion d'un membre : l'admin lui transmet un CODE
--  D'ACTIVATION (par téléphone / WhatsApp, pas par e-mail). Le membre
--  le saisit puis choisit son code secret.
--  Première connexion de l'admin : il choisit directement son code secret.
--  5 erreurs → compte bloqué jusqu'à ce que l'admin génère un nouveau code.
--
--  La vérification est faite PAR LA BASE : une session qui n'a pas donné
--  le bon code ne voit aucun bien, même en bricolant la page.
-- ============================================================

create extension if not exists pgcrypto with schema extensions;

-- ------------------------------------------------------------
-- 1. SECRETS (jamais lisibles directement, même par l'admin)
-- ------------------------------------------------------------
create table if not exists public.membres_secrets (
  membre_id          uuid primary key references public.membres(id) on delete cascade,
  pin_hash           text,
  activation_hash    text,
  activation_expire  timestamptz,
  tentatives         int not null default 0,
  updated_at         timestamptz not null default now()
);
alter table public.membres_secrets enable row level security;
revoke all on public.membres_secrets from anon, authenticated;

-- Sessions de connexion ayant donné le bon code secret
create table if not exists public.sessions_verifiees (
  session_id   uuid primary key,
  email        text not null,
  verified_at  timestamptz not null default now()
);
alter table public.sessions_verifiees enable row level security;
revoke all on public.sessions_verifiees from anon, authenticated;

-- ------------------------------------------------------------
-- 2. FONCTIONS D'ACCÈS (remplacent celles de schema.sql)
-- ------------------------------------------------------------
create or replace function public.session_courante()
returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'session_id', '')::uuid
$$;

create or replace function public.session_verifiee()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.sessions_verifiees
    where session_id = public.session_courante() and email = public.email_courant()
  )
$$;

create or replace function public.est_membre()
returns boolean language sql stable security definer set search_path = public as $$
  select public.session_verifiee() and exists (
    select 1 from public.membres
    where email = public.email_courant() and statut = 'approuve'
  )
$$;

create or replace function public.est_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select public.session_verifiee() and exists (
    select 1 from public.membres
    where email = public.email_courant() and statut = 'approuve' and role = 'admin'
  )
$$;

-- Un membre retiré / refusé perd immédiatement ses sessions vérifiées
create or replace function public.membres_purge_sessions()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    delete from public.sessions_verifiees where email = old.email;
    return old;
  end if;
  if new.statut <> old.statut then
    delete from public.sessions_verifiees where email = new.email;
  end if;
  return new;
end $$;

drop trigger if exists membres_purge_sessions on public.membres;
create trigger membres_purge_sessions
  after update of statut or delete on public.membres
  for each row execute function public.membres_purge_sessions();

-- ------------------------------------------------------------
-- 3. ÉTAT DE L'UTILISATEUR CONNECTÉ
-- ------------------------------------------------------------
create or replace function public.mon_etat()
returns json language plpgsql stable security definer set search_path = public as $$
declare
  v_m public.membres;
  v_s public.membres_secrets;
begin
  select * into v_m from public.membres where email = public.email_courant();
  if not found then
    return json_build_object('statut', 'inconnu');
  end if;
  select * into v_s from public.membres_secrets where membre_id = v_m.id;
  return json_build_object(
    'id', v_m.id, 'email', v_m.email, 'nom', v_m.nom, 'prenom', v_m.prenom,
    'role', v_m.role, 'statut', v_m.statut,
    'pin_defini',         v_s.pin_hash is not null,
    'activation',         v_s.activation_hash is not null and v_s.activation_expire > now(),
    'activation_expiree', v_s.activation_hash is not null and v_s.activation_expire <= now(),
    'bloque',             coalesce(v_s.tentatives, 0) >= 5,
    'session_verifiee',   public.session_verifiee()
  );
end $$;

-- ------------------------------------------------------------
-- 4. CODE SECRET
--    Retours : 'ok' | 'incorrect:<essais restants>' | 'bloque'
--              | 'pas_de_code' | 'expire' | 'deja_defini'
-- ------------------------------------------------------------
create or replace function public.code_trop_simple(p text)
returns boolean language sql immutable as $$
  select p ~ '^(\d)\1{5}$' or p in ('123456', '654321', '012345', '123123', '121212')
$$;

-- Première connexion : code d'activation (membre) puis choix du code secret
create or replace function public.activer_code_secret(p_activation text, p_pin text)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_m   public.membres;
  v_s   public.membres_secrets;
  v_sid uuid := public.session_courante();
begin
  select * into v_m from public.membres where email = public.email_courant() and statut = 'approuve';
  if not found or v_sid is null then
    raise exception 'Accès refusé.';
  end if;
  if coalesce(p_pin, '') !~ '^\d{6}$' then
    raise exception 'Le code secret doit contenir exactement 6 chiffres.';
  end if;
  if public.code_trop_simple(p_pin) then
    raise exception 'Ce code secret est trop simple, choisissez-en un autre.';
  end if;

  select * into v_s from public.membres_secrets where membre_id = v_m.id for update;
  if found and v_s.tentatives >= 5 then return 'bloque'; end if;
  if found and v_s.pin_hash is not null then return 'deja_defini'; end if;

  if found and v_s.activation_hash is not null then
    if v_s.activation_expire <= now() then return 'expire'; end if;
    if extensions.crypt(coalesce(p_activation, ''), v_s.activation_hash) <> v_s.activation_hash then
      update public.membres_secrets set tentatives = tentatives + 1, updated_at = now() where membre_id = v_m.id;
      return case when v_s.tentatives + 1 >= 5 then 'bloque' else 'incorrect:' || (4 - v_s.tentatives) end;
    end if;
  elsif v_m.role <> 'admin' then
    -- Un membre ne peut pas choisir son code sans le code d'activation de l'admin
    return 'pas_de_code';
  end if;

  insert into public.membres_secrets (membre_id, pin_hash, activation_hash, activation_expire, tentatives, updated_at)
  values (v_m.id, extensions.crypt(p_pin, extensions.gen_salt('bf')), null, null, 0, now())
  on conflict (membre_id) do update
    set pin_hash = excluded.pin_hash, activation_hash = null, activation_expire = null,
        tentatives = 0, updated_at = now();

  insert into public.sessions_verifiees (session_id, email) values (v_sid, v_m.email)
  on conflict (session_id) do nothing;
  return 'ok';
end $$;

-- Connexions suivantes : vérification du code secret
create or replace function public.verifier_code_secret(p_pin text)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_m   public.membres;
  v_s   public.membres_secrets;
  v_sid uuid := public.session_courante();
begin
  select * into v_m from public.membres where email = public.email_courant() and statut = 'approuve';
  if not found or v_sid is null then
    raise exception 'Accès refusé.';
  end if;

  select * into v_s from public.membres_secrets where membre_id = v_m.id for update;
  if not found or v_s.pin_hash is null then return 'pas_de_code'; end if;
  if v_s.tentatives >= 5 then return 'bloque'; end if;

  if extensions.crypt(coalesce(p_pin, ''), v_s.pin_hash) = v_s.pin_hash then
    update public.membres_secrets set tentatives = 0, updated_at = now() where membre_id = v_m.id;
    insert into public.sessions_verifiees (session_id, email) values (v_sid, v_m.email)
    on conflict (session_id) do nothing;
    delete from public.sessions_verifiees where verified_at < now() - interval '180 days';
    return 'ok';
  end if;

  update public.membres_secrets set tentatives = tentatives + 1, updated_at = now() where membre_id = v_m.id;
  return case when v_s.tentatives + 1 >= 5 then 'bloque' else 'incorrect:' || (4 - v_s.tentatives) end;
end $$;

-- ------------------------------------------------------------
-- 5. ADMIN : codes d'activation
-- ------------------------------------------------------------
-- Génère un code d'activation (valable 7 jours) et réinitialise le code secret.
-- Sert aussi à débloquer un membre ou à remplacer un code secret oublié.
create or replace function public.generer_code_activation(p_membre uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_m    public.membres;
  v_b    bytea := extensions.gen_random_bytes(3);
  v_code text;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administrateur.';
  end if;
  select * into v_m from public.membres where id = p_membre;
  if not found or v_m.statut <> 'approuve' then
    raise exception 'Membre introuvable ou pas encore accepté.';
  end if;
  if v_m.email = public.email_courant() then
    raise exception 'Vous ne pouvez pas réinitialiser votre propre code depuis l''application.';
  end if;

  v_code := lpad(((get_byte(v_b, 0) * 65536 + get_byte(v_b, 1) * 256 + get_byte(v_b, 2)) % 1000000)::text, 6, '0');

  insert into public.membres_secrets (membre_id, pin_hash, activation_hash, activation_expire, tentatives, updated_at)
  values (v_m.id, null, extensions.crypt(v_code, extensions.gen_salt('bf')), now() + interval '7 days', 0, now())
  on conflict (membre_id) do update
    set pin_hash = null, activation_hash = excluded.activation_hash,
        activation_expire = excluded.activation_expire, tentatives = 0, updated_at = now();

  -- Ses connexions en cours devront repasser par le nouveau code
  delete from public.sessions_verifiees where email = v_m.email;
  return v_code;
end $$;

-- État de sécurité de chaque membre (pour le panneau admin, sans les secrets)
create or replace function public.etat_securite_membres()
returns table (membre_id uuid, pin_defini boolean, activation_valide boolean, bloque boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administrateur.';
  end if;
  return query
    select m.id,
           s.pin_hash is not null,
           coalesce(s.activation_hash is not null and s.activation_expire > now(), false),
           coalesce(s.tentatives, 0) >= 5
    from public.membres m
    left join public.membres_secrets s on s.membre_id = m.id;
end $$;

-- ------------------------------------------------------------
-- 6. DROITS
-- ------------------------------------------------------------
revoke execute on function public.mon_etat()                            from public, anon;
revoke execute on function public.activer_code_secret(text, text)       from public, anon;
revoke execute on function public.verifier_code_secret(text)            from public, anon;
revoke execute on function public.generer_code_activation(uuid)         from public, anon;
revoke execute on function public.etat_securite_membres()               from public, anon;
grant  execute on function public.mon_etat()                            to authenticated;
grant  execute on function public.activer_code_secret(text, text)       to authenticated;
grant  execute on function public.verifier_code_secret(text)            to authenticated;
grant  execute on function public.generer_code_activation(uuid)         to authenticated;
grant  execute on function public.etat_securite_membres()               to authenticated;
grant  execute on function public.session_courante()                    to anon, authenticated;
grant  execute on function public.session_verifiee()                    to anon, authenticated;
