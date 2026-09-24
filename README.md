# 🏡 ImmoFamille

Application web pour gérer les biens immobiliers de la famille (terrains, maisons, bâtiments, entreprises) : carte, photos, documents légaux, export PDF.

Les données sont **partagées** entre les membres de la famille, avec **5 personnes maximum** : l'administrateur et 4 proches.

## 🔐 Fonctionnement des accès

1. Vous envoyez le lien de l'application à un proche.
2. Il clique sur **« Demander l'accès »** et renseigne son **prénom, son nom et son e-mail**.
3. Vous (l'admin) voyez la demande dans l'onglet **Famille** (une pastille compte les demandes en attente) et vous cliquez sur **Accepter** ou **Refuser**.
4. Quand vous acceptez, **un e-mail avec un code à 6 chiffres lui est envoyé automatiquement**. Un bouton permet aussi de le prévenir sur WhatsApp.
5. Il ouvre l'app, saisit son e-mail et clique sur **« Première connexion »**. Il colle le code reçu (ou clique sur le lien de l'e-mail), puis **crée son mot de passe**.
6. Ensuite, il se connecte avec **son e-mail et son mot de passe**, sur n'importe quel appareil.
7. **Mot de passe oublié ?** Un nouveau code est envoyé par e-mail, et il choisit un nouveau mot de passe.

Le mot de passe doit faire **au moins 8 caractères, avec au moins une lettre et un chiffre**.

| Qui | Peut faire |
|---|---|
| **Admin** | tout : accepter, refuser et retirer des membres, supprimer des biens |
| **Membre accepté** | voir, ajouter et modifier les biens, exporter en PDF et JSON |
| **Demande en attente ou refusée** | rien : écran « en attente » ou « refusée » |

Les règles sont vérifiées **par la base de données** et pas seulement par l'interface. Même en bricolant la page, on ne peut ni dépasser 5 membres, ni lire les biens sans avoir été accepté, ni retirer l'administrateur. **Retirer un membre supprime aussi son compte de connexion.**

## ⚙️ Installation (une seule fois, environ 15 minutes)

L'application utilise **[Supabase](https://supabase.com)** (gratuit) pour la base de données, les fichiers et la connexion par e-mail.

### 1. Créer le projet Supabase
- Créez un compte sur supabase.com, puis **New project** (choisissez une région proche, par ex. *West EU*).

### 2. Créer les tables et les règles de sécurité
- Ouvrez `supabase/schema.sql` et, **tout en bas**, remplacez `VOTRE_EMAIL@exemple.com`, `VOTRE_NOM` et `VOTRE_PRENOM` par **vos** informations. Ce compte sera l'administrateur.
- Dans Supabase : **SQL Editor → New query**, collez tout le fichier, puis **Run**.
- Faites de même avec **`supabase/03_mot_de_passe.sql`**, qui gère les comptes et les mots de passe. (Si vous aviez exécuté l'ancien `02_code_secret.sql`, ce fichier le remplace et le nettoie.)

### 3. Relier l'application à Supabase
- Dans Supabase : **Project Settings → API**. Copiez la **Project URL** et la clé **anon public**.
- Collez-les dans `config.js`.
  (La clé *anon* est faite pour être publique. Ne mettez **jamais** la clé *service_role* dans ce fichier.)

### 4. Mettre l'application en ligne
L'app est publiée avec **GitHub Pages** (dépôt → **Settings → Pages → Branch : `main` / root**) à l'adresse :
**https://agbecidavid.github.io/immo-app-famille/**

Chaque `git push` sur `main` met le site à jour en 1 à 2 minutes (onglet **Actions** → « pages build and deployment »).

> **À chaque mise en ligne**, changez le numéro `?v=…` des fichiers en bas de `index.html` (par ex. `?v=2026.10.02`). Sinon, pendant 10 minutes, certains téléphones pourraient mélanger l'ancienne et la nouvelle version.

Sur téléphone, on peut **l'ajouter à l'écran d'accueil** : elle s'ouvre alors comme une application.
- Android (Chrome) : menu **⋮ → Ajouter à l'écran d'accueil**.
- iPhone (Safari) : bouton **Partager → Sur l'écran d'accueil**.

Pour tester sur votre ordinateur : `python3 -m http.server 8000`, puis ouvrez `http://localhost:8000`.

> Ouvrir `index.html` en double-cliquant dessus (`file://`) ne marche pas : le lien de connexion a besoin d'une vraie adresse web.

### 5. Autoriser l'adresse de l'app pour les liens de connexion
Dans Supabase : **Authentication → URL Configuration**
- **Site URL** : `https://agbecidavid.github.io/immo-app-famille/`
- **Redirect URLs** : ajoutez `https://agbecidavid.github.io/immo-app-famille/**` (et `http://localhost:8000/**` pour tester en local)

### 5 bis. Brancher un service d'envoi d'e-mails (obligatoire pour la famille)
Le service d'envoi gratuit de Supabase **n'envoie qu'aux membres de votre équipe Supabase**, et seulement quelques e-mails par heure. Vos proches ne recevraient rien. Branchez votre propre service (SMTP). Avec Gmail, c'est gratuit :

1. Sur votre compte Google, activez la **validation en deux étapes**, puis créez un **mot de passe d'application** : https://myaccount.google.com/apppasswords (nom : « ImmoFamille »). Notez les 16 lettres.
2. Dans Supabase : **Authentication → Emails → SMTP Settings** (bouton « Set up SMTP »), activez **Enable custom SMTP** :
   - **Sender email** : votre adresse Gmail · **Sender name** : `ImmoFamille`
   - **Host** : `smtp.gmail.com` · **Port** : `465`
   - **Username** : votre adresse Gmail · **Password** : le mot de passe d'application (sans espaces)
3. Dans **Authentication → Rate Limits**, montez « Emails sent per hour » à `30`.
4. Dans **Authentication → Sign In / Providers → Email** :
   - **Email OTP Expiration** : `86400` (le code reste valable 24 h, le temps que le proche ouvre ses e-mails) ;
   - **Minimum password length** : `8`, et **Password requirements** : *Letters and digits*.

### 5 ter. Mettre le code dans l'e-mail de connexion
Une fois le SMTP branché, les modèles deviennent modifiables. Pour que l'e-mail contienne un **code à taper dans l'app** (et pas seulement un lien), allez dans **Authentication → Emails**. Dans **les deux modèles « Magic Link » et « Confirm signup »**, remplacez le contenu par :

**Sujet :** `Votre code de connexion ImmoFamille`

```html
<h2>Connexion à ImmoFamille</h2>
<p>Votre code de connexion :</p>
<p style="font-size:30px;font-weight:bold;letter-spacing:6px">{{ .Token }}</p>
<p>Saisissez-le dans l'application. Il n'est valable que peu de temps.</p>
<p>Vous pouvez aussi <a href="{{ .ConfirmationURL }}">cliquer ici pour vous connecter</a>.</p>
<p>Si vous n'avez rien demandé, ignorez simplement cet e-mail.</p>
```

### 6. Première connexion
Ouvrez l'app, cliquez sur **Se connecter** avec votre e-mail d'admin, puis cliquez sur le lien reçu.
Si des biens de l'ancienne version sont enregistrés dans ce navigateur, l'app propose de les **transférer dans l'espace familial**.

## 🆘 Mot de passe oublié (vous ou un membre)
Sur l'écran de connexion : saisir son e-mail, puis **« Mot de passe oublié ? »**. Un code arrive par e-mail, et on choisit un nouveau mot de passe.

## ⚠️ Bon à savoir (offre gratuite Supabase)
- **Mise en pause après 7 jours sans activité.** Si personne n'utilise l'app pendant une semaine, le projet se met en pause. Il suffit de le relancer depuis le tableau de bord Supabase. Les données ne sont pas perdues.
- **E-mails de connexion limités** à quelques-uns par heure avec le service d'envoi intégré. Pour 5 personnes, c'est suffisant, et on reste connecté longtemps sur un appareil. Si besoin, on peut brancher son propre service d'envoi (SMTP).
- Stockage inclus : 1 Go de fichiers (photos et documents) et 500 Mo de base de données.
- **Sauvegarde** : le bouton ⬇️ exporte tous les biens **avec leurs photos et documents** dans un fichier JSON. Le bouton ⬆️ permet de le réimporter.

## 📁 Fichiers
| Fichier | Rôle |
|---|---|
| `index.html` | structure des pages |
| `style.css` | apparence (thèmes clair et sombre, mobile) |
| `app.js` | logique de l'application |
| `manifest.webmanifest`, `icons/` | installation sur l'écran d'accueil du téléphone |
| `icons.js` | icônes de l'interface ([Lucide](https://lucide.dev), licence ISC) |
| `config.js` | adresse et clé publique de **votre** projet Supabase |
| `supabase/schema.sql` | tables, règles de sécurité et limite de 5 membres |
| `supabase/03_mot_de_passe.sql` | comptes, mots de passe, état des invitations |
