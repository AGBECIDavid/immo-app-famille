# 🏡 ImmoFamille

Application web pour gérer les biens immobiliers de la famille (terrains, maisons, bâtiments, entreprises) : carte, photos, documents légaux, export PDF.

Les données sont **partagées** entre les membres de la famille, avec **5 personnes maximum** : l'administrateur et 4 proches.

## 🔐 Fonctionnement des accès

1. Vous envoyez le lien de l'application à un proche.
2. Il clique sur **« Demander l'accès »** et renseigne son **prénom, son nom et son e-mail**.
3. Vous (l'admin) voyez la demande dans le panneau **👑** (un badge rouge compte les demandes en attente) et vous cliquez sur **✅ Accepter** ou **❌ Refuser**.
4. Le bouton **✉️ Prévenir** ouvre un e-mail tout prêt pour lui dire que c'est validé.
5. Il revient sur l'app, clique sur **« Se connecter »** et saisit son e-mail. Il reçoit un **lien de connexion par e-mail**. Il n'a pas de mot de passe à retenir.

| Qui | Peut faire |
|---|---|
| **Admin** | tout : accepter, refuser et retirer des membres, supprimer des biens |
| **Membre accepté** | voir, ajouter et modifier les biens, exporter en PDF et JSON |
| **Demande en attente ou refusée** | rien : écran « en attente » ou « refusée » |

Les règles sont vérifiées **par la base de données** et pas seulement par l'interface. Même en bricolant la page, on ne peut ni dépasser 5 membres, ni lire les biens sans avoir été accepté, ni retirer l'administrateur.

## ⚙️ Installation (une seule fois, environ 15 minutes)

L'application utilise **[Supabase](https://supabase.com)** (gratuit) pour la base de données, les fichiers et la connexion par e-mail.

### 1. Créer le projet Supabase
- Créez un compte sur supabase.com, puis **New project** (choisissez une région proche, par ex. *West EU*).

### 2. Créer les tables et les règles de sécurité
- Ouvrez `supabase/schema.sql` et, **tout en bas**, remplacez `VOTRE_EMAIL@exemple.com`, `VOTRE_NOM` et `VOTRE_PRENOM` par **vos** informations. Ce compte sera l'administrateur.
- Dans Supabase : **SQL Editor → New query**, collez tout le fichier, puis **Run**.

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

*(Facultatif)* Dans **Authentication → Emails → Magic Link**, traduisez l'e-mail en français.

### 6. Première connexion
Ouvrez l'app, cliquez sur **Se connecter** avec votre e-mail d'admin, puis cliquez sur le lien reçu.
Si des biens de l'ancienne version sont enregistrés dans ce navigateur, l'app propose de les **transférer dans l'espace familial**.

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
| `config.js` | adresse et clé publique de **votre** projet Supabase |
| `supabase/schema.sql` | tables, règles de sécurité et limite de 5 membres |
