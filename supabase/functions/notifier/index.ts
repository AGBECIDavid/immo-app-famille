// ============================================================
//  ImmoFamille — fonction « notifier » (Supabase Edge Function)
//  Appelée par la base (supabase/04_notifications.sql) :
//    { type: 'demande', id }  → prévient les administrateurs
//    { type: 'bien',    id }  → prévient les autres membres
//    { type: 'test',    id }  → notification de test (id = e-mail du membre)
//  Elle relit toujours les données dans la base : le contenu de
//  l'appel ne sert qu'à savoir QUOI annoncer.
//
//  Secrets à définir (Edge Functions → Secrets) :
//    NOTIFY_SECRET      : affiché à la fin de 04_notifications.sql
//    VAPID_PUBLIC_KEY   : clé publique (outils/cles-notifications.html)
//    VAPID_PRIVATE_KEY  : clé privée   (idem — à ne jamais publier)
//  Dans les réglages de la fonction : désactiver « Verify JWT ».
// ============================================================
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2';

const env = (key: string) => Deno.env.get(key) ?? '';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

type Message = { title: string; body: string; url: string; tag: string };

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST uniquement' }, 405);

  const secret = env('NOTIFY_SECRET');
  if (!secret || req.headers.get('x-notify-secret') !== secret) {
    return json({ error: 'accès refusé' }, 403);
  }

  const { type, id } = await req.json().catch(() => ({}));
  if (typeof id !== 'string' || !id) return json({ error: 'id manquant' }, 400);

  const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_SECRET_KEY'), {
    auth: { persistSession: false }
  });

  let emails: string[] = [];
  let message: Message;

  if (type === 'demande') {
    const { data: m } = await db.from('membres').select('prenom, nom, statut').eq('id', id).maybeSingle();
    if (!m || m.statut !== 'en_attente') return json({ sent: 0, reason: 'demande introuvable' });
    const { data: admins } = await db.from('membres').select('email').eq('role', 'admin').eq('statut', 'approuve');
    emails = (admins ?? []).map((a) => a.email);
    message = {
      title: "Nouvelle demande d'accès",
      body: `${m.prenom} ${m.nom} souhaite rejoindre la famille.`,
      url: '?ouvrir=famille',
      tag: 'demande-' + id
    };
  } else if (type === 'bien') {
    const { data: b } = await db.from('biens').select('id, nom, adresse, created_by').eq('id', id).maybeSingle();
    if (!b) return json({ sent: 0, reason: 'bien introuvable' });
    const { data: membres } = await db.from('membres').select('email, prenom').eq('statut', 'approuve');
    const auteur = (membres ?? []).find((m) => m.email === b.created_by);
    emails = (membres ?? []).filter((m) => m.email !== b.created_by).map((m) => m.email);
    message = {
      title: 'Nouveau bien ajouté',
      body: b.nom + (b.adresse ? ` · ${b.adresse}` : '') + (auteur ? ` (par ${auteur.prenom})` : ''),
      url: '?ouvrir=bien:' + b.id,
      tag: 'bien-' + b.id
    };
  } else if (type === 'test') {
    // Test demandé par un membre depuis l'app : id = son e-mail, envoyé à lui seul
    const { data: m } = await db.from('membres').select('email').eq('email', id).eq('statut', 'approuve').maybeSingle();
    if (!m) return json({ sent: 0, reason: 'membre introuvable' });
    emails = [m.email];
    message = {
      title: 'Notifications activées ✓',
      body: 'Tout fonctionne : vous serez prévenu ici des nouveautés de la famille.',
      url: './',
      tag: 'test'
    };
  } else {
    return json({ error: 'type inconnu' }, 400);
  }

  if (!emails.length) return json({ sent: 0 });
  const { data: abonnements } = await db.from('push_abonnements').select('endpoint, p256dh, auth').in('email', emails);
  if (!abonnements?.length) return json({ sent: 0 });

  webpush.setVapidDetails('mailto:notifications@immofamille.invalid', env('VAPID_PUBLIC_KEY'), env('VAPID_PRIVATE_KEY'));

  let sent = 0, removed = 0;
  await Promise.all(abonnements.map(async (a) => {
    try {
      await webpush.sendNotification(
        { endpoint: a.endpoint, keys: { p256dh: a.p256dh, auth: a.auth } },
        JSON.stringify(message),
        { TTL: 60 * 60 * 24 }
      );
      sent++;
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        // Abonnement expiré (app désinstallée, notifications coupées…) : on le retire
        await db.from('push_abonnements').delete().eq('endpoint', a.endpoint);
        removed++;
      } else {
        console.error('Envoi impossible :', status, (e as Error).message);
      }
    }
  }));

  return json({ sent, removed });
});
