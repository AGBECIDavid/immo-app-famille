-- ============================================================
--  ImmoFamille — Connexion par mot de passe (à exécuter APRÈS schema.sql)
--  Supabase > SQL Editor > New query > coller ce fichier > Run
--
--  Remplace l'ancien « code secret à 6 chiffres » (02_code_secret.sql) :
--    - 1re connexion : code reçu par e-mail → création du mot de passe
--    - ensuite       : e-mail + mot de passe, sur n'importe quel appareil
--    - mot de passe oublié : nouveau code par e-mail → nouveau mot de passe
--  L'accès aux biens reste réservé aux membres acceptés par l'admin.
--  Ce fichier peut être exécuté même si 02_code_secret.sql ne l'a jamais été.
-- ============================================================

-- ------------------------------------------------------------
-- 1. ACCÈS : membre accepté (le code secret n'est plus exigé)
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- 2. NETTOYAGE de l'ancien code secret
-- ------------------------------------------------------------
drop trigger  if exists membres_purge_sessions on public.membres;
drop function if exists public.membres_purge_sessions();
drop function if exists public.activer_code_secret(text, text);
drop function if exists public.verifier_code_secret(text);
drop function if exists public.generer_code_activation(uuid);
drop function if exists public.etat_securite_membres();
drop function if exists public.code_trop_simple(text);
drop function if exists public.session_verifiee();
drop function if exists public.session_courante();
drop table    if exists public.sessions_verifiees;
drop table    if exists public.membres_secrets;

-- ------------------------------------------------------------
-- 3. ÉTAT DE L'UTILISATEUR CONNECTÉ
-- ------------------------------------------------------------
drop function if exists public.mon_etat();
create function public.mon_etat()
returns json language plpgsql stable security definer set search_path = public as $$
declare
  v_m public.membres;
begin
  select * into v_m from public.membres where email = public.email_courant();
  if not found then
    return json_build_object('statut', 'inconnu');
  end if;
  return json_build_object(
    'id', v_m.id, 'email', v_m.email, 'nom', v_m.nom, 'prenom', v_m.prenom,
    'role', v_m.role, 'statut', v_m.statut
  );
end $$;

-- ------------------------------------------------------------
-- 4. ADMIN : état des comptes de connexion (sans aucun secret)
--    compte_cree   : le membre a déjà été invité (code envoyé)
--    mot_de_passe  : il a créé son mot de passe → compte activé
-- ------------------------------------------------------------
create or replace function public.etat_comptes()
returns table (membre_id uuid, compte_cree boolean, mot_de_passe boolean, derniere_connexion timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administrateur.';
  end if;
  return query
    select m.id,
           u.id is not null,
           coalesce(u.encrypted_password, '') <> '',
           u.last_sign_in_at
    from public.membres m
    left join auth.users u on lower(u.email) = m.email;
end $$;

-- ------------------------------------------------------------
-- 5. Retirer un membre supprime aussi son compte de connexion
-- ------------------------------------------------------------
create or replace function public.membres_supprimer_compte()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from auth.users where lower(email) = old.email;
  return old;
end $$;

drop trigger if exists membres_supprimer_compte on public.membres;
create trigger membres_supprimer_compte
  after delete on public.membres
  for each row execute function public.membres_supprimer_compte();

-- ------------------------------------------------------------
-- 6. DROITS
-- ------------------------------------------------------------
revoke execute on function public.mon_etat()      from public, anon;
revoke execute on function public.etat_comptes()  from public, anon;
grant  execute on function public.mon_etat()      to authenticated;
grant  execute on function public.etat_comptes()  to authenticated;
