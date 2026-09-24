# 🏡 ImmoFamille

Application web pour gérer les biens immobiliers de la famille (terrains, maisons, bâtiments, entreprises) : carte, photos, documents légaux, export PDF.

Les données sont **partagées** entre les membres de la famille, avec **5 personnes maximum** : l'administrateur et 4 proches.

## 🔐 Fonctionnement des accès

1. Vous envoyez le lien de l'application à un proche.
2. Il clique sur **« Demander l'accès »** et renseigne son **prénom, son nom et son e-mail**.
3. Vous (l'admin) voyez la demande dans le panneau **👑** (un badge rouge compte les demandes en attente) et vous cliquez sur **✅ Accepter** ou **❌ Refuser**.
4. Quand vous acceptez, l'app affiche un **code d'activation à 6 chiffres**. Donnez-le **par téléphone, SMS ou WhatsApp**, jamais par e-mail. Des boutons sont prévus pour ça.
5. Il revient sur l'app, clique sur **« Se connecter »**, saisit son e-mail puis le **code reçu par e-mail**.
6. La première fois, il saisit le **code d'activation**, puis il choisit son **code secret** à 6 chiffres.
7. Aux connexions suivantes, sur un nouvel appareil ou après une déconnexion, on lui demande **le code e-mail + son code secret**.

### Pourquoi deux vérifications ?
- **Le code e-mail** prouve que la personne possède la boîte mail.
- **Le code d'activation** prouve que c'est bien la personne que vous avez acceptée. Quelqu'un qui aurait fait une demande avec le nom d'un proche ne l'aura jamais, puisque vous le donnez de vive voix.
- **Le code secret** protège le compte même si la boîte mail est piratée ou ouverte sur un appareil partagé.
- **5 erreurs** bloquent le compte. Le bouton **🔑 Code** du panneau admin génère alors un nouveau code d'activation. Il sert aussi quand un membre a oublié son code secret.

| Qui | Peut faire |
|---|---|
| **Admin** | tout : accepter, refuser et retirer des membres, supprimer des biens |
| **Membre accepté** | voir, ajouter et modifier les biens, exporter en PDF et JSON |
| **Demande en attente ou refusée** | rien : écran « en attente » ou « refusée » |
| **Connecté sans code secret** | rien : la base refuse l'accès tant que le code secret n'est pas donné |

Les règles sont vérifiées **par la base de données** et pas seulement par l'interface. Même en bricolant la page, on ne peut ni dépasser 5 membres, ni lire les biens sans avoir été accepté **et** sans avoir donné son code secret, ni retirer l'administrateur. Les codes sont stockés chiffrés (bcrypt), même vous ne pouvez pas les lire.

## ⚙️ Installation (une seule fois, environ 15 minutes)

L'application utilise **[Supabase](https://supabase.com)** (gratuit) pour la base de données, les fichiers et la connexion par e-mail.

### 1. Créer le projet Supabase
- Créez un compte sur supabase.com, puis **New project** (choisissez une région proche, par ex. *West EU*).

### 2. Créer les tables et les règles de sécurité
- Ouvrez `supabase/schema.sql` et, **tout en bas**, remplacez `VOTRE_EMAIL@exemple.com`, `VOTRE_NOM` et `VOTRE_PRENOM` par **vos** informations. Ce compte sera l'administrateur.
- Dans Supabase : **SQL Editor → New query**, collez tout le fichier, puis **Run**.
- Faites de même avec **`supabase/02_code_secret.sql`**, qui ajoute la double vérification.

### 3. Relier l'application à Supabase
- Dans Supabase : **Project Settings → API**. Copiez la **Project URL** et la clé **anon public**.
- Collez-les dans `config.js`.
  (La clé *anon* est faite pour être publique. Ne mettez **jamais** la clé *service_role* dans ce fichier.)

### 4. Mettre l'application en ligne
Avec **GitHub Pages** : dans le dépôt GitHub, **Settings → Pages → Branch : `main` / root**. L'app sera disponible à une adresse du type
`https://agbecidavid.github.io/immo-app-famille/`

Pour tester sur votre ordinateur : `python3 -m http.server 8000`, puis ouvrez `http://localhost:8000`.

> Ouvrir `index.html` en double-cliquant dessus (`file://`) ne marche pas : le lien de connexion a besoin d'une vraie adresse web.

### 5. Autoriser l'adresse de l'app pour les liens de connexion
Dans Supabase : **Authentication → URL Configuration**
- **Site URL** : l'adresse de l'app (par ex. `https://agbecidavid.github.io/immo-app-famille/`)
- **Redirect URLs** : ajoutez la même adresse (et `http://localhost:8000/` si vous testez en local)

### 5 bis. Brancher un service d'envoi d'e-mails (obligatoire pour la famille)
Le service d'envoi gratuit de Supabase **n'envoie qu'aux membres de votre équipe Supabase**, et seulement quelques e-mails par heure. Vos proches ne recevraient rien. Branchez votre propre service (SMTP). Avec Gmail, c'est gratuit :

1. Sur votre compte Google, activez la **validation en deux étapes**, puis créez un **mot de passe d'application** : https://myaccount.google.com/apppasswords (nom : « ImmoFamille »). Notez les 16 lettres.
2. Dans Supabase : **Authentication → Emails → SMTP Settings** (bouton « Set up SMTP »), activez **Enable custom SMTP** :
   - **Sender email** : votre adresse Gmail · **Sender name** : `ImmoFamille`
   - **Host** : `smtp.gmail.com` · **Port** : `465`
   - **Username** : votre adresse Gmail · **Password** : le mot de passe d'application (sans espaces)
3. Dans **Authentication → Rate Limits**, montez « Emails sent per hour » à `30`.

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

## 🆘 J'ai oublié MON code secret (admin)
Dans Supabase, ouvrez **SQL Editor** et exécutez :
```sql
delete from public.membres_secrets
where membre_id = (select id from public.membres where role = 'admin');
```
À la prochaine connexion, l'app vous demandera de choisir un nouveau code secret.

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
| `icons.js` | icônes de l'interface ([Lucide](https://lucide.dev), licence ISC) |
| `config.js` | adresse et clé publique de **votre** projet Supabase |
| `supabase/schema.sql` | tables, règles de sécurité et limite de 5 membres |
| `supabase/02_code_secret.sql` | double vérification : code d'activation et code secret |
