-- ============================================================
--  ImmoFamille — Notifications sur téléphone (à exécuter APRÈS 03)
--  Supabase > SQL Editor > New query > coller ce fichier > Run
--
--  - Un proche demande l'accès      → notification à l'administrateur
--  - Un nouveau bien est ajouté     → notification aux autres membres
--
--  La base appelle la fonction « notifier » (supabase/functions/notifier),
--  qui envoie les notifications aux téléphones abonnés.
--  Voir le README, section « Notifications », pour la mise en place.
-- ============================================================

create extension if not exists pg_net with schema extensions;

-- ------------------------------------------------------------
-- 1. ABONNEMENTS : un par appareil ayant activé les notifications
-- ------------------------------------------------------------
create table if not exists public.push_abonnements (
  endpoint    text primary key check (endpoint ~ '^https://'),
  email       text not null default public.email_courant(),
  p256dh      text not null,
  auth        text not null,
  created_at  timestamptz not null default now()
);

alter table public.push_abonnements enable row level security;

drop policy if exists push_lecture on public.push_abonnements;
create policy push_lecture on public.push_abonnements
  for select to authenticated using (email = public.email_courant());

drop policy if exists push_ajout on public.push_abonnements;
create policy push_ajout on public.push_abonnements
  for insert to authenticated with check (email = public.email_courant() and public.est_membre());

drop policy if exists push_maj on public.push_abonnements;
create policy push_maj on public.push_abonnements
  for update to authenticated using (email = public.email_courant()) with check (email = public.email_courant());

drop policy if exists push_suppression on public.push_abonnements;
create policy push_suppression on public.push_abonnements
  for delete to authenticated using (email = public.email_courant());

grant select, insert, update, delete on public.push_abonnements to authenticated;

-- Un membre retiré ne reçoit plus rien
create or replace function public.membres_supprimer_abonnements()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from public.push_abonnements where email = old.email;
  return old;
end $$;

drop trigger if exists membres_supprimer_abonnements on public.membres;
create trigger membres_supprimer_abonnements
  after delete on public.membres
  for each row execute function public.membres_supprimer_abonnements();

-- ------------------------------------------------------------
-- 2. CONFIGURATION : adresse de la fonction + secret partagé
--    (illisible depuis l'application ; le secret est généré ici)
-- ------------------------------------------------------------
create table if not exists public.notif_config (
  id            int primary key default 1 check (id = 1),
  function_url  text not null,
  secret        text not null
);
alter table public.notif_config enable row level security;
revoke all on public.notif_config from anon, authenticated;

-- ⚠️ Adresse de VOTRE fonction : Project URL + /functions/v1/notifier
insert into public.notif_config (id, function_url, secret)
values (1, 'https://jspdkdbyubxohfzdybgv.supabase.co/functions/v1/notifier',
        encode(extensions.gen_random_bytes(24), 'hex'))
on conflict (id) do update set function_url = excluded.function_url;   -- le secret existant est conservé

-- ------------------------------------------------------------
-- 3. DÉCLENCHEURS : la base prévient la fonction (sans jamais bloquer)
-- ------------------------------------------------------------
create or replace function public.envoyer_notification(p_type text, p_id text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v public.notif_config;
begin
  select * into v from public.notif_config where id = 1;
  if not found then
    return;
  end if;
  perform net.http_post(
    url     := v.function_url,
    body    := jsonb_build_object('type', p_type, 'id', p_id),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-notify-secret', v.secret)
  );
exception when others then
  -- Une notification ratée ne doit jamais empêcher l'enregistrement
  raise warning 'Notification non envoyée : %', sqlerrm;
end $$;

revoke execute on function public.envoyer_notification(text, text) from public, anon, authenticated;

create or replace function public.notif_nouvelle_demande()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.statut = 'en_attente' then
    perform public.envoyer_notification('demande', new.id::text);
  end if;
  return new;
end $$;

drop trigger if exists notif_nouvelle_demande on public.membres;
create trigger notif_nouvelle_demande
  after insert on public.membres
  for each row execute function public.notif_nouvelle_demande();

create or replace function public.notif_nouveau_bien()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.envoyer_notification('bien', new.id);
  return new;
end $$;

drop trigger if exists notif_nouveau_bien on public.biens;
create trigger notif_nouveau_bien
  after insert on public.biens
  for each row execute function public.notif_nouveau_bien();

-- ------------------------------------------------------------
-- 4. À COPIER : le secret à coller dans les « Secrets » de la fonction
--    (Edge Functions → Secrets → NOTIFY_SECRET)
-- ------------------------------------------------------------
select secret as "NOTIFY_SECRET (à copier)" from public.notif_config where id = 1;
