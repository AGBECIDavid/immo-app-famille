/* ============================================================
   ImmoFamille — app.js
   Application de gestion de biens immobiliers
   Espace familial partagé (Supabase) — 5 membres maximum
============================================================ */

'use strict';

/* ============================================================
   CONSTANTES
============================================================ */
const MAX_PHOTOS   = 5;
const MAX_DOCS     = 5;
const MAX_IMG_SIZE = 5  * 1024 * 1024;   // 5 Mo
const MAX_DOC_SIZE = 10 * 1024 * 1024;   // 10 Mo

const MAX_MEMBRES  = 5;                   // admin compris (vérifié aussi par la base)
const BUCKET       = 'fichiers';          // bucket Supabase Storage (privé)
const SIGNED_URL_TTL = 3600;              // durée de validité des liens photos (s)

const STORAGE_KEY  = 'immofamille_biens';          // ancienne version (localStorage)
const MIGRATION_KEY= 'immofamille_migration_faite';
const THEME_KEY    = 'immofamille_theme';

const ALLOWED_IMG_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const ALLOWED_DOC_MIMES = [
  'application/pdf',
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
];

const TYPE_CONFIG = {
  terrain:    { icon: 'trees',      label: 'Terrain',             cssVar: '--terrain'    },
  maison:     { icon: 'house',      label: 'Maison',              cssVar: '--maison'     },
  batiment:   { icon: 'building-2', label: 'Bâtiment commercial', cssVar: '--batiment'   },
  entreprise: { icon: 'factory',    label: 'Entreprise',          cssVar: '--entreprise' }
};

const LEGAL_DOCS_LIST = [
  { id: 'titre_foncier',     label: 'Titre foncier'        },
  { id: 'permis_construire', label: 'Permis de construire' },
  { id: 'contrat_achat',     label: "Contrat d'achat"      },
  { id: 'plan_cadastral',    label: 'Plan cadastral'       }
];

/* ============================================================
   ÉTAT GLOBAL
============================================================ */
let currentFilter = 'all';
let editingId     = null;
let mapInstance   = null;
let mapPicker     = null;
let mapDetail     = null;
let pickerMarker  = null;
let mapMarkers    = {};
let formPhotos    = [];
let formDocs      = [];
let saving        = false;

// Supabase
let sb            = null;   // client Supabase
let session       = null;   // session de connexion
let currentMember = null;   // ligne "membres" de l'utilisateur connecté
let biensCache    = [];     // biens chargés depuis la base
let membresCache  = [];     // (admin) toutes les demandes / membres

/* ============================================================
   🔐 SÉCURITÉ — Échappement et nettoyage
============================================================ */
function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])
  );
}

function escAttr(str) {
  return String(str ?? '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function sanitizeInput(str) {
  if (str == null) return '';
  // Retire balises HTML et scripts éventuels
  return String(str)
    .replace(/<[^>]*>/g, '')
    .trim()
    .slice(0, 5000);
}

function sanitizeFileName(name) {
  return String(name)
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\.{2,}/g, '.')
    .slice(0, 255);
}

/* ============================================================
   🌍 CONVERSION DMS → DÉCIMAL
   Accepte les formats Google Maps :
     6°22'30.5"N 2°19'08.9"E
     6 22 30.5 N, 2 19 8.9 E
     6°22'30.5N, 2°19'08.9E
============================================================ */
function convertDMS_to_Decimal(dmsStr) {
  if (!dmsStr || typeof dmsStr !== 'string') return null;

  // Normaliser : remplacer toutes les variantes de quotes typographiques
  // par des quotes ASCII standards
  const normalized = dmsStr
    .replace(/[\u2032\u2019\u02BC]/g, "'")    // ′ ’ ʼ → '
    .replace(/[\u2033\u201D\u201C]/g, '"')    // ″ ” “ → "
    .replace(/[°º˚]/g, '°');                  // variantes de degré

  // Regex : degrés (entier ou décimal), minutes, secondes optionnelles, direction optionnelle
  const partRegex = /(\d+(?:[.,]\d+)?)\s*°\s*(\d+(?:[.,]\d+)?)\s*'\s*(?:(\d+(?:[.,]\d+)?)\s*"?\s*)?([NSEWnsew])?/g;

  const parts = [];
  let match;
  while ((match = partRegex.exec(normalized)) !== null) {
    const deg = parseFloat(match[1].replace(',', '.'));
    const min = parseFloat(match[2].replace(',', '.'));
    const sec = match[3] ? parseFloat(match[3].replace(',', '.')) : 0;
    const dir = match[4] ? match[4].toUpperCase() : null;

    if (isNaN(deg) || isNaN(min) || isNaN(sec)) continue;

    let decimal = deg + min / 60 + sec / 3600;
    if (dir === 'S' || dir === 'W') decimal = -Math.abs(decimal);

    parts.push({ decimal, dir });
  }

  if (parts.length !== 2) return null;

  // Identifier lat (N/S) et lng (E/W)
  let lat = null, lng = null;
  for (const p of parts) {
    if (p.dir === 'N' || p.dir === 'S')      lat = p.decimal;
    else if (p.dir === 'E' || p.dir === 'W') lng = p.decimal;
  }
  // Si pas de directions explicites : 1ère = lat, 2ème = lng
  if (lat === null && lng === null) {
    lat = parts[0].decimal;
    lng = parts[1].decimal;
  }

  if (lat === null || lng === null) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  return {
    lat: parseFloat(lat.toFixed(6)),
    lng: parseFloat(lng.toFixed(6))
  };
}

function applyDMS() {
  const raw   = document.getElementById('f-dms').value.trim();
  const errEl = document.getElementById('dms-error');
  errEl.classList.remove('visible');
  errEl.textContent = '';

  if (!raw) {
    errEl.textContent = 'Veuillez coller des coordonnées dans le champ ci-dessus.';
    errEl.classList.add('visible');
    return;
  }

  const result = convertDMS_to_Decimal(raw);
  if (!result) {
    errEl.textContent = 'Format non reconnu. Exemple : 6°22\'30.5"N 2°19\'08.9"E';
    errEl.classList.add('visible');
    return;
  }

  setPickerPosition(result.lat, result.lng);
  document.getElementById('f-dms').value = '';
  showToast(`Converti : ${result.lat}, ${result.lng}`, 'success');
}

/* ============================================================
   💾 STOCKAGE — Supabase (base partagée par la famille)
   getBiens() reste synchrone : il lit le cache chargé par loadBiens().
============================================================ */
function getBiens() {
  return biensCache;
}

function rowToBien(r) {
  return {
    id:          r.id,
    nom:         r.nom,
    type:        r.type,
    description: r.description || '',
    adresse:     r.adresse || '',
    lat:         r.lat,
    lng:         r.lng,
    legalDocs:   Array.isArray(r.legal_docs) ? r.legal_docs : [],
    photos:      Array.isArray(r.photos) ? r.photos : [],
    docs:        Array.isArray(r.docs)   ? r.docs   : [],
    createdBy:   r.created_by,
    createdAt:   r.created_at,
    updatedAt:   r.updated_at
  };
}

async function loadBiens() {
  if (!sb) return false;
  const { data, error } = await sb.from('biens').select('*').order('created_at', { ascending: false });
  if (error) {
    console.error('Erreur chargement biens :', error);
    showToast('Impossible de charger les biens : ' + error.message, 'error');
    return false;
  }
  const biens = data.map(rowToBien);

  // Liens temporaires pour afficher les photos (bucket privé)
  const paths = biens.flatMap(b => b.photos.map(p => p.path)).filter(Boolean);
  if (paths.length) {
    const { data: signed, error: signErr } = await sb.storage.from(BUCKET).createSignedUrls(paths, SIGNED_URL_TTL);
    if (signErr) console.error('Erreur liens photos :', signErr);
    const urls = new Map((signed || []).filter(x => x.signedUrl).map(x => [x.path, x.signedUrl]));
    biens.forEach(b => b.photos.forEach(p => { p.url = urls.get(p.path) || ''; }));
  }

  biensCache = biens;
  return true;
}

function newId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// Les clés Supabase Storage n'acceptent que des caractères simples
function storageSafeName(name) {
  return String(name || 'fichier')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/_{2,}/g, '_')
    .slice(-100) || 'fichier';
}

function photoSrc(p) {
  return p.url || p.previewUrl || p.dataUrl || '';
}

/**
 * Envoie dans Storage les fichiers qui n'y sont pas encore (ceux qui ont un `file`).
 * `uploaded` reçoit les chemins créés, pour pouvoir annuler en cas d'échec.
 */
async function uploadFiles(bienId, kind, items, uploaded) {
  const out = [];
  for (const it of items) {
    if (!it.path) {
      if (!it.file) continue;
      const path = `biens/${bienId}/${kind}/${newId()}-${storageSafeName(it.name)}`;
      const { error } = await sb.storage.from(BUCKET).upload(path, it.file, {
        contentType: it.file.type || 'application/octet-stream',
        upsert: false
      });
      if (error) throw new Error(`envoi de "${it.name}" impossible (${error.message})`);
      it.path = path;
      uploaded.push({ item: it, path });
    }
    out.push(kind === 'photos'
      ? { name: it.name, path: it.path }
      : { name: it.name, size: it.size, path: it.path });
  }
  return out;
}

async function removeStoragePaths(paths) {
  const list = paths.filter(Boolean);
  if (!list.length) return;
  const { error } = await sb.storage.from(BUCKET).remove(list);
  if (error) console.warn('Fichiers non supprimés :', error.message);
}

async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function pathToDataUrl(path) {
  const { data, error } = await sb.storage.from(BUCKET).download(path);
  if (error) throw error;
  return blobToDataUrl(data);
}

async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}

/* ============================================================
   🌗 DARK MODE
============================================================ */
function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch (e) { /* ignore */ }
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(saved || (prefersDark ? 'dark' : 'light'));
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const dark = theme === 'dark';
  const btn = document.getElementById('theme-btn');
  if (btn) btn.innerHTML = icon(dark ? 'sun' : 'moon');
  const menuIcon  = document.getElementById('theme-menu-icon');
  const menuLabel = document.getElementById('theme-menu-label');
  if (menuIcon)  menuIcon.innerHTML = icon(dark ? 'sun' : 'moon');
  if (menuLabel) menuLabel.textContent = dark ? 'Thème clair' : 'Thème sombre';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#161412' : '#FAF7F2');
  try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* ignore */ }
}

/* Fonds de carte gratuits, sans clé d'API :
   - Plan      : OpenStreetMap (teinté en CSS pour suivre le thème clair / sombre)
   - Satellite : imagerie Esri + noms de lieux, pratique pour voir les parcelles */
const MAP_STYLE_KEY = 'immofamille_fond_carte';
const mapsWithBase  = [];   // cartes qui ont un fond (pour basculer toutes ensemble)

function currentMapStyle() {
  try { return localStorage.getItem(MAP_STYLE_KEY) === 'satellite' ? 'satellite' : 'plan'; }
  catch (e) { return 'plan'; }
}

function makeBaseLayers() {
  return {
    plan: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap',
      maxZoom: 19
    }),
    satellite: L.layerGroup([
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Imagerie &copy; Esri, Maxar, Earthstar Geographics',
        maxZoom: 19, maxNativeZoom: 18
      }),
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 19, maxNativeZoom: 18
      })
    ])
  };
}

// Bouton « Plan / Satellite » en bas à gauche de chaque carte
const MapStyleControl = L.Control.extend({
  options: { position: 'bottomleft' },
  onAdd() {
    const btn = L.DomUtil.create('button', 'map-style-btn');
    btn.type = 'button';
    L.DomEvent.disableClickPropagation(btn);
    L.DomEvent.on(btn, 'click', () => setMapStyle(currentMapStyle() === 'plan' ? 'satellite' : 'plan'));
    this._btn = btn;
    this.refresh();
    return btn;
  },
  refresh() {
    // Le bouton propose l'autre fond
    const toSat = currentMapStyle() === 'plan';
    this._btn.innerHTML = icon(toSat ? 'satellite' : 'map') + `<span>${toSat ? 'Satellite' : 'Plan'}</span>`;
    this._btn.setAttribute('aria-label', toSat ? 'Afficher la vue satellite' : 'Afficher le plan');
  }
});

function applyMapStyle(entry) {
  const style = currentMapStyle();
  Object.entries(entry.layers).forEach(([name, layer]) => {
    if (name === style) { if (!entry.map.hasLayer(layer)) layer.addTo(entry.map); }
    else if (entry.map.hasLayer(layer)) entry.map.removeLayer(layer);
  });
  entry.map.getContainer().classList.toggle('map-plan', style === 'plan');
  entry.control.refresh();
}

function setMapStyle(style) {
  try { localStorage.setItem(MAP_STYLE_KEY, style); } catch (e) { /* ignore */ }
  mapsWithBase.forEach(applyMapStyle);
}

function addBaseLayer(map) {
  const entry = { map, layers: makeBaseLayers(), control: new MapStyleControl() };
  entry.control.addTo(map);
  mapsWithBase.push(entry);
  applyMapStyle(entry);
  map.on('unload', () => {
    const i = mapsWithBase.indexOf(entry);
    if (i !== -1) mapsWithBase.splice(i, 1);
  });
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  applyTheme(current === 'dark' ? 'light' : 'dark');
}

/* ============================================================
   ⏳ LOADER
============================================================ */
function showLoader() { document.getElementById('loader').classList.add('visible'); }
function hideLoader() { document.getElementById('loader').classList.remove('visible'); }

/* ============================================================
   🧭 NAVIGATION ENTRE VUES
============================================================ */
const APP_VIEWS = ['home', 'form', 'detail', 'admin'];

let gateView = 'auth';        // dernier écran « hors app » affiché (connexion, mot de passe, attente…)
let accessGranted = false;   // membre accepté ET étape du mot de passe franchie

function isApproved() { return !!(currentMember && currentMember.statut === 'approuve'); }
function hasAccess()  { return isApproved() && accessGranted; }
function isAdmin()    { return hasAccess() && currentMember.role === 'admin'; }

// Connecté mais pas (encore) autorisé → on reste sur l'écran d'étape en cours
function fallbackView() {
  return session ? gateView : 'auth';
}

function goHome() {
  showView(hasAccess() ? 'home' : fallbackView());
}

function showView(name, bienId) {
  // Garde-fous : pages réservées aux membres vérifiés / à l'admin
  if (APP_VIEWS.includes(name) && !hasAccess()) name = fallbackView();
  if (name === 'admin' && !isAdmin()) name = 'home';
  if (!APP_VIEWS.includes(name)) gateView = name;

  document.body.classList.toggle('auth-mode', !APP_VIEWS.includes(name));

  showLoader();
  setTimeout(() => {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const target = document.getElementById('view-' + name);
    if (target) target.classList.add('active');
    hideLoader();
    window.scrollTo(0, 0);

    closeUserMenu();
    document.querySelectorAll('.topnav-link').forEach(l =>
      l.classList.toggle('active', l.dataset.nav === name || (l.dataset.nav === 'home' && ['form', 'detail'].includes(name))));
    setMobileMap(false);

    if (name === 'home') {
      initMap();
      renderList();
      // Recharger pour voir les ajouts des autres membres
      loadBiens().then(ok => { if (ok) { refreshMapMarkers(); renderList(); } });
      if (isAdmin()) loadMembres();
    } else if (name === 'form') {
      resetForm(bienId);
      initMapPicker();
    } else if (name === 'detail' && bienId) {
      renderDetail(bienId);
    } else if (name === 'admin') {
      renderAdmin();
      loadMembres().then(renderAdmin);
    }
  }, 120);
}

/* ============================================================
   🗺️ CARTE PRINCIPALE
============================================================ */
function initMap() {
  // Si déjà initialisée → on rafraîchit juste la taille
  if (mapInstance) {
    setTimeout(() => mapInstance.invalidateSize(), 50);
    refreshMapMarkers();
    return;
  }
  // Centre par défaut : Cotonou
  mapInstance = L.map('map', { zoomControl: false }).setView([6.3703, 2.3912], 7);
  L.control.zoom({ position: 'bottomright' }).addTo(mapInstance);
  addBaseLayer(mapInstance);
  // Vue éloignée : pilules réduites à l'icône pour éviter qu'elles se chevauchent
  const compact = () => document.getElementById('map').classList.toggle('map-compact', mapInstance.getZoom() < 12);
  mapInstance.on('zoomend', compact);
  compact();
  refreshMapMarkers();
  // Rafraîchir la taille après affichage
  setTimeout(() => mapInstance.invalidateSize(), 200);
}

function typeInfo(type) {
  return TYPE_CONFIG[type] || { icon: 'house', label: type || 'Bien', cssVar: '--muted' };
}

// Couleur du type, utilisable en style inline : style="--type-color: var(--terrain)"
function typeStyle(type) {
  return `--type-color: var(${typeInfo(type).cssVar})`;
}

function makeMarkerIcon(b) {
  const t = typeInfo(b.type);
  return L.divIcon({
    className: 'pin-wrap',
    html: `<div class="pin" style="${typeStyle(b.type)}">${icon(t.icon)}<span>${esc(b.nom)}</span></div>`,
    iconSize: null,
    iconAnchor: [0, 0],
    popupAnchor: [0, -40]
  });
}

function refreshMapMarkers() {
  if (!mapInstance) return;
  Object.values(mapMarkers).forEach(m => mapInstance.removeLayer(m));
  mapMarkers = {};

  const biens = getBiens();
  const bounds = [];

  biens.forEach(b => {
    if (b.lat == null || b.lng == null) return;
    const marker = L.marker([b.lat, b.lng], { icon: makeMarkerIcon(b), riseOnHover: true })
      .addTo(mapInstance)
      .bindPopup(buildPopup(b), { maxWidth: 240, minWidth: 240, closeButton: true });

    marker.on('click', () => highlightCard(b.id));

    mapMarkers[b.id] = marker;
    bounds.push([b.lat, b.lng]);
  });

  if (bounds.length === 1)    mapInstance.setView(bounds[0], 14);
  else if (bounds.length > 1) mapInstance.fitBounds(bounds, { padding: [60, 60] });
}

function buildPopup(b) {
  const t = typeInfo(b.type);
  const media = b.photos && b.photos.length
    ? `<img src="${escAttr(photoSrc(b.photos[0]))}" alt=""/>`
    : `<div class="bien-placeholder" style="${typeStyle(b.type)}">${icon(t.icon)}</div>`;
  return `<div class="map-popup">
    <div class="popup-media">${media}</div>
    <div class="popup-body">
      <strong>${esc(b.nom)}</strong>
      <small>${esc(t.label)}${b.adresse ? ' · ' + esc(b.adresse) : ''}</small>
      <button class="btn btn-primary" onclick="showView('detail','${b.id}')">Voir la fiche</button>
    </div>
  </div>`;
}

function highlightCard(id) {
  document.querySelectorAll('.bien-card').forEach(c => c.classList.remove('highlighted'));
  const card = document.getElementById('card-' + id);
  if (card) {
    card.classList.add('highlighted');
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// Survol d'une carte de la liste → sa pilule s'allume sur la carte
function setMarkerActive(id, active) {
  const marker = mapMarkers[id];
  const el = marker && marker.getElement();
  if (!el) return;
  el.classList.toggle('is-active', active);
  const pin = el.querySelector('.pin');
  if (pin) pin.classList.toggle('active', active);
}

/* Mobile : bascule entre la liste et la carte */
function setMobileMap(show) {
  const layout = document.getElementById('home-layout');
  if (!layout) return;
  layout.classList.toggle('show-map', show);
  document.getElementById('map-toggle-label').textContent = show ? 'Liste' : 'Carte';
  document.getElementById('map-toggle-icon').innerHTML = icon(show ? 'list' : 'map');
  // La carte a été créée cachée : on recalcule sa taille puis on recadre sur les biens
  if (show && mapInstance) setTimeout(() => { mapInstance.invalidateSize(); refreshMapMarkers(); }, 50);
}

function toggleMobileMap() {
  setMobileMap(!document.getElementById('home-layout').classList.contains('show-map'));
}

/* ============================================================
   📋 LISTE DES BIENS
============================================================ */
function setFilter(f, btn) {
  currentFilter = f;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderList();
}

function normalize(str) {
  return String(str ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

function onSearch() {
  const val = document.getElementById('search-input').value;
  document.getElementById('search-clear').classList.toggle('visible', val.length > 0);
  renderList();
}

function clearSearch() {
  document.getElementById('search-input').value = '';
  document.getElementById('search-clear').classList.remove('visible');
  renderList();
}

function renderList() {
  const search = normalize(document.getElementById('search-input')?.value || '');
  const sort   = document.getElementById('sort-select')?.value || 'date-desc';
  const all    = getBiens();
  let biens    = all.slice();

  // Résumé en haut de la liste
  const complets = all.filter(b => getStatut(b).complet).length;
  const summary  = document.getElementById('home-summary');
  if (summary) {
    summary.textContent = all.length
      ? `${all.length} bien${all.length > 1 ? 's' : ''} · ${complets} dossier${complets > 1 ? 's' : ''} complet${complets > 1 ? 's' : ''}` +
        (all.length - complets ? ` · ${all.length - complets} à compléter` : '')
      : 'Aucun bien enregistré pour le moment';
  }

  if (currentFilter !== 'all') biens = biens.filter(b => b.type === currentFilter);

  if (search) biens = biens.filter(b =>
    normalize(b.nom).includes(search) ||
    normalize(b.adresse  || '').includes(search) ||
    normalize(b.description || '').includes(search)
  );

  biens.sort((a, b) => {
    if (sort === 'nom-asc')  return a.nom.localeCompare(b.nom, 'fr');
    if (sort === 'nom-desc') return b.nom.localeCompare(a.nom, 'fr');
    if (sort === 'date-asc') return new Date(a.createdAt) - new Date(b.createdAt);
    if (sort === 'docs-asc') return getStatut(a).presents - getStatut(b).presents;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  const container = document.getElementById('biens-list');
  if (!container) return;

  if (!biens.length) {
    container.innerHTML = all.length
      ? `<div class="empty-state">
           <div class="state-icon">${icon('search')}</div>
           <h3>Aucun résultat</h3>
           <p>Aucun bien ne correspond à votre recherche ou à ce filtre.</p>
           <button class="btn btn-secondary" onclick="clearSearch(); setFilter('all', document.querySelector('.filter-btn'))">Tout afficher</button>
         </div>`
      : `<div class="empty-state">
           <div class="state-icon">${icon('house-plus')}</div>
           <h3>Commencez par votre premier bien</h3>
           <p>Ajoutez un terrain, une maison ou un bâtiment : sa position, ses photos et ses documents.</p>
           <button class="btn btn-primary" onclick="showView('form', null)">${icon('plus')}Ajouter un bien</button>
         </div>`;
    return;
  }

  container.innerHTML = biens.map(b => {
    const t      = typeInfo(b.type);
    const statut = getStatut(b);
    const media  = b.photos && b.photos.length
      ? `<img src="${escAttr(photoSrc(b.photos[0]))}" alt="" loading="lazy"/>`
      : `<div class="bien-placeholder">${icon(t.icon)}</div>`;

    return `<article class="bien-card" id="card-${b.id}" tabindex="0" style="${typeStyle(b.type)}"
              onclick="showView('detail','${b.id}')"
              onkeydown="if (event.key === 'Enter') showView('detail','${b.id}')"
              onmouseenter="setMarkerActive('${b.id}', true)" onmouseleave="setMarkerActive('${b.id}', false)">
      <div class="bien-media">
        ${media}
        <span class="type-tag">${icon(t.icon)}${esc(t.label)}</span>
      </div>
      <div class="bien-body">
        <h3 class="bien-name">${esc(b.nom)}</h3>
        ${b.adresse ? `<p class="bien-loc">${icon('map-pin')}${esc(b.adresse)}</p>` : ''}
        <div class="bien-foot">
          ${statutHtml(statut)}
          <div class="progress"><div class="progress-bar${statut.complet ? ' full' : ''}" style="width:${statut.pct}%"></div></div>
        </div>
      </div>
    </article>`;
  }).join('');
}

/* ============================================================
   🏷️ TYPE DE BIEN (cartes cliquables)
============================================================ */
function setType(type) {
  document.getElementById('f-type').value = type || '';
  document.querySelectorAll('.type-option').forEach(o => {
    const on = o.dataset.type === type;
    o.classList.toggle('selected', on);
    o.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  // La pilule de la carte reprend l'icône du type
  if (pickerMarker) {
    pickerMarker.setIcon(makeMarkerIcon({ type, nom: document.getElementById('f-nom').value.trim() || 'Position du bien' }));
  }
}

/* ============================================================
   🗺️ CARTE FORMULAIRE
============================================================ */
function initMapPicker() {
  setTimeout(() => {
    const container = document.getElementById('map-picker');
    if (!container) return;

    // Si déjà initialisée → juste rafraîchir
    if (mapPicker) {
      mapPicker.invalidateSize();
      return;
    }

    mapPicker = L.map('map-picker').setView([6.3703, 2.3912], 7);
    addBaseLayer(mapPicker);

    mapPicker.on('click', e => setPickerPosition(e.latlng.lat, e.latlng.lng));
    setTimeout(() => mapPicker.invalidateSize(), 200);
  }, 100);
}

function setPickerPosition(lat, lng) {
  // S'assurer que la carte existe
  if (!mapPicker) {
    initMapPicker();
    setTimeout(() => setPickerPosition(lat, lng), 300);
    return;
  }

  document.getElementById('f-lat').value = parseFloat(lat).toFixed(6);
  document.getElementById('f-lng').value = parseFloat(lng).toFixed(6);

  if (pickerMarker) mapPicker.removeLayer(pickerMarker);
  const type = document.getElementById('f-type').value;
  pickerMarker = L.marker([lat, lng], {
    icon: makeMarkerIcon({ type, nom: document.getElementById('f-nom').value.trim() || 'Position du bien' })
  }).addTo(mapPicker);
  mapPicker.setView([lat, lng], 14);
}

/* ============================================================
   📡 GÉOLOCALISATION
============================================================ */
function useMyLocation() {
  const btn = document.getElementById('btn-geo');

  if (!navigator.geolocation) {
    return showToast('Géolocalisation non supportée par ce navigateur.', 'error');
  }

  btn.innerHTML = icon('locate-fixed') + 'Localisation…';
  btn.classList.add('loading');

  navigator.geolocation.getCurrentPosition(
    pos => {
      btn.innerHTML = icon('locate-fixed') + 'Utiliser ma position';
      btn.classList.remove('loading');
      setPickerPosition(pos.coords.latitude, pos.coords.longitude);
      showToast('Position détectée !', 'success');
    },
    err => {
      btn.innerHTML = icon('locate-fixed') + 'Utiliser ma position';
      btn.classList.remove('loading');
      const msgs = {
        1: 'Permission refusée. Autorisez la localisation dans votre navigateur.',
        2: 'Position indisponible.',
        3: 'Délai dépassé. Réessayez.'
      };
      showToast('' + (msgs[err.code] || 'Erreur de géolocalisation.'), 'error');
    },
    { timeout: 10000, enableHighAccuracy: true }
  );
}

/* ============================================================
   📸 UPLOAD PHOTOS
============================================================ */
function handlePhotos(files) {
  Array.from(files).forEach(file => {
    if (!ALLOWED_IMG_MIMES.includes(file.type)) {
      return showToast(`"${sanitizeFileName(file.name)}" n'est pas une image valide (JPEG, PNG, WEBP, GIF).`, 'error');
    }
    if (file.size > MAX_IMG_SIZE) {
      return showToast(`"${sanitizeFileName(file.name)}" dépasse 5 Mo.`, 'error');
    }
    if (formPhotos.length >= MAX_PHOTOS) {
      return showToast(`Maximum ${MAX_PHOTOS} photos.`, 'error');
    }

    // Le fichier sera envoyé dans Supabase au moment de l'enregistrement
    formPhotos.push({ name: sanitizeFileName(file.name), file, previewUrl: URL.createObjectURL(file) });
  });
  renderPhotoPreviews();
  document.getElementById('f-photos').value = '';
}

function handleDrop(e, type) {
  e.preventDefault();
  const zoneId = type === 'photo' ? 'photo-zone' : 'doc-zone';
  document.getElementById(zoneId).classList.remove('drag-over');
  if (type === 'photo') handlePhotos(e.dataTransfer.files);
  else                  handleDocs(e.dataTransfer.files);
}

function renderPhotoPreviews() {
  const container = document.getElementById('photo-preview');
  container.innerHTML = formPhotos.map((p, i) =>
    `<div class="preview-item">
      <img src="${escAttr(photoSrc(p))}" alt="${esc(p.name)}"/>
      ${i === 0 ? '<span class="cover-tag">Couverture</span>' : ''}
      <button type="button" class="remove-btn" onclick="removePhoto(${i})" aria-label="Retirer la photo">${icon('x')}</button>
    </div>`
  ).join('');

  const rem = MAX_PHOTOS - formPhotos.length;
  document.getElementById('photo-counter').textContent = formPhotos.length === 0
    ? `${MAX_PHOTOS} photos maximum`
    : `${formPhotos.length}/${MAX_PHOTOS} · encore ${rem} possible${rem > 1 ? 's' : ''}`;
}

function removePhoto(i) {
  const [removed] = formPhotos.splice(i, 1);
  if (removed && removed.previewUrl) URL.revokeObjectURL(removed.previewUrl);
  renderPhotoPreviews();
}

/* ============================================================
   📎 UPLOAD DOCUMENTS
============================================================ */
function handleDocs(files) {
  Array.from(files).forEach(file => {
    if (!ALLOWED_DOC_MIMES.includes(file.type)) {
      return showToast(`"${sanitizeFileName(file.name)}" : type non autorisé (PDF, image, Word).`, 'error');
    }
    if (file.size > MAX_DOC_SIZE) {
      return showToast(`"${sanitizeFileName(file.name)}" dépasse 10 Mo.`, 'error');
    }
    if (formDocs.length >= MAX_DOCS) {
      return showToast(`Maximum ${MAX_DOCS} documents.`, 'error');
    }

    formDocs.push({ name: sanitizeFileName(file.name), size: file.size, file });
  });
  renderDocPreviews();
  document.getElementById('f-docs').value = '';
}

function renderDocPreviews() {
  const container = document.getElementById('doc-preview');
  container.innerHTML = formDocs.map((d, i) =>
    `<div class="file-item">
      <span class="file-icon">${icon(docIcon(d.name))}</span>
      <span class="file-name">${esc(d.name)}</span>
      <span class="file-size">${formatSize(d.size)}</span>
      <button type="button" class="file-remove" onclick="removeDoc(${i})" aria-label="Retirer le fichier">${icon('x')}</button>
    </div>`
  ).join('');

  const rem = MAX_DOCS - formDocs.length;
  document.getElementById('doc-counter').textContent = formDocs.length === 0
    ? `${MAX_DOCS} fichiers maximum`
    : `${formDocs.length}/${MAX_DOCS} · encore ${rem} possible${rem > 1 ? 's' : ''}`;
}

function removeDoc(i) {
  formDocs.splice(i, 1);
  renderDocPreviews();
}

/* ============================================================
   ✅ STATUT AUTOMATIQUE & CHECKLIST
============================================================ */
function getStatut(b) {
  const legalDocs = b.legalDocs || [];
  const total     = LEGAL_DOCS_LIST.length;
  const presents  = legalDocs.filter(d => d.present).length;
  const complet   = presents === total;
  return {
    complet,
    presents,
    total,
    pct:    total ? Math.round(presents / total * 100) : 0,
    texte:  complet ? 'Dossier complet' : `${presents}/${total} documents`,
    classe: complet ? 'statut-complet' : 'statut-incomplet'
  };
}

function statutHtml(statut) {
  return `<span class="statut ${statut.classe}">${icon(statut.complet ? 'circle-check' : 'triangle-alert')}${statut.texte}</span>`;
}

function renderChecklist(existingDocs) {
  const container = document.getElementById('checklist-container');
  if (!container) return;

  container.innerHTML = LEGAL_DOCS_LIST.map(def => {
    const existing = (existingDocs || []).find(d => d.id === def.id);
    const checked  = existing ? existing.present : false;
    const ref      = existing ? (existing.reference || '') : '';
    const det      = existing ? (existing.detenteur || '') : '';

    return `<div class="checklist-item ${checked ? 'has-doc' : ''}" id="cli-${def.id}">
      <div class="checklist-item-top">
        <input type="checkbox" class="checklist-checkbox"
               id="chk-${def.id}"
               ${checked ? 'checked' : ''}
               onchange="onChecklistChange('${def.id}', this.checked)"/>
        <label class="checklist-label" for="chk-${def.id}">${def.label}</label>
        <span class="checklist-status">${checked ? 'Disponible' : 'Manquant'}</span>
      </div>
      <div class="checklist-fields">
        <input type="text" class="input checklist-input" id="ref-${def.id}"
               placeholder="Référence / numéro" value="${escAttr(ref)}" aria-label="Référence ${escAttr(def.label)}"/>
        <input type="text" class="input checklist-input" id="det-${def.id}"
               placeholder="Qui détient l'original ?" value="${escAttr(det)}" aria-label="Détenteur ${escAttr(def.label)}"/>
      </div>
    </div>`;
  }).join('');

  updateChecklistProgress();
}

function onChecklistChange(docId, checked) {
  const item = document.getElementById('cli-' + docId);
  if (!item) return;
  const status = item.querySelector('.checklist-status');
  item.classList.toggle('has-doc', checked);
  if (status) status.textContent = checked ? 'Disponible' : 'Manquant';
  updateChecklistProgress();
}

function updateChecklistProgress() {
  const total    = LEGAL_DOCS_LIST.length;
  const presents = LEGAL_DOCS_LIST.filter(d => {
    const el = document.getElementById('chk-' + d.id);
    return el && el.checked;
  }).length;

  const pct = total ? Math.round(presents / total * 100) : 0;
  const bar  = document.getElementById('docs-progress-bar');
  const text = document.getElementById('docs-progress-text');
  const pctEl= document.getElementById('docs-progress-pct');

  if (bar)   { bar.style.width = pct + '%'; bar.classList.toggle('full', presents === total); }
  if (text)  text.textContent = `${presents} document${presents > 1 ? 's' : ''} sur ${total}`;
  if (pctEl) pctEl.textContent = pct + '%';
}

function collectLegalDocs() {
  return LEGAL_DOCS_LIST.map(def => {
    const chk = document.getElementById('chk-' + def.id);
    const ref = document.getElementById('ref-' + def.id);
    const det = document.getElementById('det-' + def.id);
    return {
      id:        def.id,
      label:     def.label,
      present:   chk ? chk.checked : false,
      reference: sanitizeInput(ref ? ref.value.trim() : ''),
      detenteur: sanitizeInput(det ? det.value.trim() : '')
    };
  });
}

/* ============================================================
   💾 SAUVEGARDE — Ajout & Modification
============================================================ */
async function saveBien() {
  if (saving) return;

  const nom  = document.getElementById('f-nom').value.trim();
  const type = document.getElementById('f-type').value;
  const desc = document.getElementById('f-desc').value.trim();
  const lat  = document.getElementById('f-lat').value;
  const lng  = document.getElementById('f-lng').value;

  // --- Validation ---
  if (!nom)        return showToast('Veuillez saisir un nom.', 'error');
  if (!type)       return showToast('Veuillez choisir un type.', 'error');
  if (!desc)       return showToast('Veuillez saisir une description.', 'error');
  if (!lat || !lng) return showToast('Veuillez définir la position GPS sur la carte.', 'error');

  const latF = parseFloat(lat);
  const lngF = parseFloat(lng);
  if (isNaN(latF) || latF < -90  || latF > 90)  return showToast('Latitude invalide.', 'error');
  if (isNaN(lngF) || lngF < -180 || lngF > 180) return showToast('Longitude invalide.', 'error');

  const old = editingId ? getBiens().find(b => b.id === editingId) : null;
  if (editingId && !old) return showToast('Bien introuvable.', 'error');

  const id       = editingId || newId();
  const uploaded = [];
  const saveBtn  = document.getElementById('btn-save');
  saving = true;
  showLoader();
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Enregistrement…'; }

  try {
    const photos = await uploadFiles(id, 'photos', formPhotos, uploaded);
    const docs   = await uploadFiles(id, 'docs',   formDocs,   uploaded);

    const row = {
      nom:         sanitizeInput(nom).slice(0, 200),
      type,
      description: sanitizeInput(desc),
      adresse:     sanitizeInput(document.getElementById('f-adresse').value.trim()).slice(0, 500),
      lat:         latF,
      lng:         lngF,
      legal_docs:  collectLegalDocs(),
      photos,
      docs
    };

    let res;
    if (editingId) {
      row.updated_at = new Date().toISOString();
      res = await sb.from('biens').update(row).eq('id', id).select('id');
    } else {
      res = await sb.from('biens').insert({ id, ...row }).select('id');
    }
    if (res.error) throw new Error(res.error.message);
    if (!res.data || !res.data.length) throw new Error('accès refusé (êtes-vous toujours membre ?)');

    // Supprimer les fichiers retirés pendant la modification
    if (old) {
      const kept = new Set([...photos, ...docs].map(f => f.path));
      await removeStoragePaths([...old.photos, ...old.docs].map(f => f.path).filter(p => !kept.has(p)));
    }

    showToast(editingId ? 'Bien modifié !' : 'Bien enregistré !', 'success');
    editingId  = null;
    formPhotos = [];
    formDocs   = [];
    showView('home');
  } catch (e) {
    console.error('Erreur sauvegarde :', e);
    // Annuler les envois de cette tentative pour ne pas laisser de fichiers orphelins
    await removeStoragePaths(uploaded.map(u => u.path));
    uploaded.forEach(u => { delete u.item.path; });
    showToast('Enregistrement impossible : ' + e.message, 'error');
  } finally {
    saving = false;
    hideLoader();
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Enregistrer le bien'; }
  }
}

/* ============================================================
   🔄 RESET / PRÉ-REMPLISSAGE FORMULAIRE
============================================================ */
function resetForm(bienId) {
  editingId = bienId || null;

  document.getElementById('form-title').textContent =
    bienId ? 'Modifier le bien' : 'Ajouter un bien';
  document.getElementById('form-subtitle').textContent =
    bienId ? 'Modifiez les informations de ce bien.' : 'Renseignez les informations de votre bien.';

  // Reset des erreurs
  const dmsErr = document.getElementById('dms-error');
  if (dmsErr) { dmsErr.textContent = ''; dmsErr.classList.remove('visible'); }

  if (bienId) {
    // PRÉ-REMPLISSAGE
    const b = getBiens().find(x => x.id === bienId);
    if (!b) {
      showToast('Bien introuvable.', 'error');
      showView('home');
      return;
    }
    document.getElementById('f-nom').value     = b.nom || '';
    setType(b.type || '');
    document.getElementById('f-desc').value    = b.description || '';
    document.getElementById('f-adresse').value = b.adresse || '';
    document.getElementById('f-lat').value     = b.lat != null ? b.lat : '';
    document.getElementById('f-lng').value     = b.lng != null ? b.lng : '';
    document.getElementById('f-dms').value     = '';

    formPhotos = Array.isArray(b.photos) ? [...b.photos] : [];
    formDocs   = Array.isArray(b.docs)   ? [...b.docs]   : [];

    // Positionner le marqueur après init de la carte
    if (b.lat != null && b.lng != null) {
      setTimeout(() => setPickerPosition(b.lat, b.lng), 350);
    }

    renderChecklist(b.legalDocs);
  } else {
    // AJOUT — tout vider
    ['f-nom','f-desc','f-adresse','f-lat','f-lng','f-dms'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    setType('');
    formPhotos = [];
    formDocs   = [];

    // Retirer le marqueur précédent s'il existe
    if (mapPicker && pickerMarker) {
      mapPicker.removeLayer(pickerMarker);
      pickerMarker = null;
    }

    renderChecklist(null);
  }

  renderPhotoPreviews();
  renderDocPreviews();
}

/* ============================================================
   📄 PAGE DE DÉTAIL
============================================================ */
function renderDetail(id) {
  const b = getBiens().find(x => x.id === id);
  if (!b) {
    showToast('Bien introuvable.', 'error');
    showView('home');
    return;
  }

  const t       = typeInfo(b.type);
  const statut  = getStatut(b);
  const fmtDate = d => new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  const photos  = b.photos || [];
  const docs    = b.docs || [];

  // Galerie en mosaïque (5 photos max)
  const galleryHtml = photos.length
    ? `<div class="gallery count-${Math.min(photos.length, 5)}">${photos.slice(0, 5).map((p, i) =>
        `<button type="button" class="gallery-item" onclick="openBienPhoto('${b.id}', ${i})" aria-label="Agrandir la photo ${i + 1}">
           <img src="${escAttr(photoSrc(p))}" alt="" loading="lazy"/>
         </button>`).join('')}</div>`
    : `<div class="gallery-empty bien-placeholder" style="${typeStyle(b.type)}">${icon(t.icon)}<span>Pas encore de photo</span></div>`;

  // Documents légaux
  const legalDocs = b.legalDocs || [];
  const legalHtml = LEGAL_DOCS_LIST.map(def => {
    const d = legalDocs.find(x => x.id === def.id) || { present: false };
    const meta = [];
    if (d.reference) meta.push('Réf. ' + esc(d.reference));
    if (d.detenteur) meta.push('Détenu par ' + esc(d.detenteur));
    return `<li class="legal-item${d.present ? '' : ' missing'}">
      <span class="legal-mark ${d.present ? 'ok' : 'nok'}">${icon(d.present ? 'check' : 'x')}</span>
      <div>
        <div class="legal-label">${esc(def.label)}</div>
        <div class="legal-meta">${d.present ? (meta.join(' · ') || 'Disponible') : 'Manquant'}</div>
      </div>
    </li>`;
  }).join('');

  // Fichiers joints
  const docsHtml = docs.length
    ? `<div class="file-list">${docs.map((d, i) =>
        `<button type="button" class="file-item" onclick="downloadDoc('${b.id}', ${i})">
           <span class="file-icon">${icon(docIcon(d.name))}</span>
           <span class="file-name">${esc(d.name)}</span>
           <span class="file-size">${formatSize(d.size)}</span>
           ${icon('download')}
         </button>`).join('')}</div>`
    : `<p class="hint">Aucun fichier joint.</p>`;

  const facts = [
    ['calendar', 'Ajouté le', fmtDate(b.createdAt)],
    b.updatedAt ? ['refresh-cw', 'Modifié le', fmtDate(b.updatedAt)] : null,
    b.createdBy ? ['user', 'Ajouté par', esc(membreLabel(b.createdBy))] : null,
    b.lat != null ? ['map-pin', 'Coordonnées GPS', `${b.lat.toFixed(5)}, ${b.lng.toFixed(5)}`] : null
  ].filter(Boolean);

  const container = document.getElementById('detail-content');
  container.innerHTML = `
    <button class="back-link" onclick="showView('home')">${icon('arrow-left')}Retour aux biens</button>

    <div class="detail-top">
      <div>
        <h1 class="detail-title">${esc(b.nom)}</h1>
        <div class="detail-meta">
          <span class="type-dot" style="${typeStyle(b.type)}">${icon(t.icon)}${esc(t.label)}</span>
          ${b.adresse ? `<span>${icon('map-pin')}${esc(b.adresse)}</span>` : ''}
          ${statutHtml(statut)}
        </div>
      </div>
      <div class="detail-actions">
        <button class="btn btn-secondary" onclick="showView('form','${b.id}')">${icon('pencil')}Modifier</button>
        <button class="btn btn-secondary" id="btn-pdf-export" onclick="exportBienPDF('${b.id}')">${icon('file-down')}Fiche PDF</button>
        ${isAdmin() ? `<button class="btn btn-danger" onclick="deleteBien('${b.id}')" aria-label="Supprimer le bien">${icon('trash-2')}</button>` : ''}
      </div>
    </div>

    ${galleryHtml}

    <div class="detail-grid">
      <div>
        <section class="detail-section">
          <h2>À propos de ce bien</h2>
          ${b.description ? `<p class="detail-desc">${esc(b.description)}</p>` : '<p class="hint">Pas de description.</p>'}
        </section>
        <section class="detail-section">
          <div class="facts">${facts.map(([ic, label, value]) =>
            `<div class="fact">${icon(ic)}<div><div class="fact-label">${label}</div><div class="fact-value">${value}</div></div></div>`).join('')}
          </div>
        </section>
        <section class="detail-section">
          <h2>Où se trouve-t-il ?</h2>
          ${b.lat != null ? '<div id="map-detail"></div>' : '<p class="hint">Position non renseignée.</p>'}
        </section>
        <section class="detail-section">
          <h2>Fichiers joints</h2>
          ${docsHtml}
        </section>
      </div>

      <aside class="side-card">
        <h2>Dossier légal</h2>
        <div class="side-score"><strong>${statut.presents}/${statut.total}</strong><span>documents disponibles</span></div>
        <div class="progress"><div class="progress-bar${statut.complet ? ' full' : ''}" style="width:${statut.pct}%"></div></div>
        <ul class="legal-list">${legalHtml}</ul>
        ${statut.complet ? '' : `<button class="btn btn-secondary btn-block" onclick="showView('form','${b.id}')">${icon('clipboard-check')}Compléter le dossier</button>`}
      </aside>
    </div>
  `;

  // Carte du détail
  if (b.lat != null) {
    setTimeout(() => {
      // Important : détruire la carte précédente sinon Leaflet plante
      if (mapDetail) { mapDetail.remove(); mapDetail = null; }
      mapDetail = L.map('map-detail', { scrollWheelZoom: false }).setView([b.lat, b.lng], 15);
      addBaseLayer(mapDetail);
      L.marker([b.lat, b.lng], { icon: makeMarkerIcon(b) }).addTo(mapDetail);
      setTimeout(() => mapDetail.invalidateSize(), 100);
    }, 150);
  }
}

/* ============================================================
   🗑️ SUPPRESSION
============================================================ */
async function deleteBien(id) {
  if (!isAdmin()) return showToast('Seul l\'administrateur peut supprimer un bien.', 'error');
  const b = getBiens().find(x => x.id === id);
  if (!b) return showToast('Bien introuvable.', 'error');
  if (!confirm('Supprimer ce bien définitivement ? Cette action est irréversible.')) return;

  showLoader();
  const { data, error } = await sb.from('biens').delete().eq('id', id).select('id');
  hideLoader();
  if (error || !data || !data.length) {
    return showToast('Suppression impossible : ' + (error ? error.message : 'accès refusé'), 'error');
  }
  await removeStoragePaths([...b.photos, ...b.docs].map(f => f.path));
  showToast('Bien supprimé.', 'success');
  showView('home');
}

/* ============================================================
   📎 PHOTOS & DOCUMENTS DU DÉTAIL
============================================================ */
function openBienPhoto(bienId, i) {
  const b = getBiens().find(x => x.id === bienId);
  const p = b && b.photos[i];
  if (p) openLightbox(photoSrc(p));
}

async function downloadDoc(bienId, i) {
  const b = getBiens().find(x => x.id === bienId);
  const d = b && b.docs[i];
  if (!d) return;
  if (!d.path) return showToast('Fichier indisponible.', 'error');
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(d.path, 60, { download: d.name });
  if (error) return showToast('Téléchargement impossible : ' + error.message, 'error');
  window.location.assign(data.signedUrl);
}

// "prenom nom" si l'admin connaît le membre, sinon l'e-mail
function membreLabel(email) {
  const m = membresCache.find(x => x.email === email) ||
            (currentMember && currentMember.email === email ? currentMember : null);
  return m ? `${m.prenom} ${m.nom}` : email;
}

/* ============================================================
   🔍 LIGHTBOX
============================================================ */
function openLightbox(src) {
  document.getElementById('lightbox-img').src = src;
  document.getElementById('lightbox').classList.add('open');
}
function closeLightbox() {
  document.getElementById('lightbox').classList.remove('open');
  document.getElementById('lightbox-img').src = '';
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeLightbox(); closeInviteModal(); } });

/* ============================================================
   🔔 TOASTS
============================================================ */
function showToast(msg, type = '') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  const ic = { success: 'circle-check', error: 'triangle-alert' }[type] || 'info';
  toast.innerHTML = icon(ic);
  const text = document.createElement('span');
  text.textContent = msg;
  toast.appendChild(text);
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.transition = 'opacity .3s ease';
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3800);
}

/* ============================================================
   🛠️ UTILITAIRES
============================================================ */
function docIcon(name) {
  const ext = String(name).split('.').pop().toLowerCase();
  if (['jpg','jpeg','png','webp','gif'].includes(ext)) return 'image';
  if (['pdf','doc','docx'].includes(ext)) return 'file-text';
  return 'paperclip';
}

function formatSize(bytes) {
  if (!bytes && bytes !== 0) return '—';
  if (bytes < 1024) return bytes + ' o';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' Ko';
  return (bytes / 1048576).toFixed(1) + ' Mo';
}

/* ============================================================
   📤 EXPORT JSON — sauvegarde complète (fichiers inclus)
============================================================ */
async function exportJSON() {
  const biens = getBiens();
  if (!biens.length) return showToast('Aucun bien à exporter.', 'error');

  showLoader();
  try {
    // On embarque photos et documents pour que le fichier soit une vraie sauvegarde
    const out = [];
    for (const b of biens) {
      const photos = [];
      for (const p of b.photos) {
        if (p.path) photos.push({ name: p.name, dataUrl: await pathToDataUrl(p.path) });
      }
      const docs = [];
      for (const d of b.docs) {
        if (d.path) docs.push({ name: d.name, size: d.size, dataUrl: await pathToDataUrl(d.path) });
      }
      const { createdBy, ...rest } = b;
      out.push({ ...rest, photos, docs });
    }

    const dataStr = JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), biens: out }, null, 2);
    const blob    = new Blob([dataStr], { type: 'application/json' });
    const url     = URL.createObjectURL(blob);
    const a       = document.createElement('a');
    a.href        = url;
    a.download    = `immofamille_${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`${biens.length} bien(s) exporté(s) !`, 'success');
  } catch (e) {
    showToast('Erreur d\'export : ' + e.message, 'error');
  } finally {
    hideLoader();
  }
}

/* ============================================================
   📥 IMPORT JSON (et migration depuis l'ancienne version locale)
============================================================ */
const VALID_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Envoie une liste de biens (format export) dans la base. Retourne le nombre importé. */
async function importBiensList(list) {
  await loadBiens();   // pour ne pas réimporter un bien déjà présent
  const existingIds = new Set(getBiens().map(b => b.id));
  let imported = 0;

  for (const b of list) {
    if (!b || typeof b.nom !== 'string' || b.nom.trim() === '') continue;
    if (!Object.keys(TYPE_CONFIG).includes(b.type)) continue;
    if (b.id && existingIds.has(String(b.id))) continue;

    const lat = b.lat != null ? parseFloat(b.lat) : null;
    const lng = b.lng != null ? parseFloat(b.lng) : null;
    if (lat != null && (isNaN(lat) || lat < -90  || lat > 90))  continue;
    if (lng != null && (isNaN(lng) || lng < -180 || lng > 180)) continue;

    const id       = VALID_ID.test(String(b.id || '')) ? String(b.id) : newId();
    const uploaded = [];
    try {
      const toItems = (arr, max) => (Array.isArray(arr) ? arr : [])
        .filter(f => f && typeof f.dataUrl === 'string' && f.dataUrl.startsWith('data:'))
        .slice(0, max);
      const photoItems = [];
      for (const f of toItems(b.photos, MAX_PHOTOS)) {
        const blob = await dataUrlToBlob(f.dataUrl);
        if (!ALLOWED_IMG_MIMES.includes(blob.type)) continue;
        photoItems.push({ name: sanitizeFileName(f.name || 'photo'), file: blob });
      }
      const docItems = [];
      for (const f of toItems(b.docs, MAX_DOCS)) {
        const blob = await dataUrlToBlob(f.dataUrl);
        if (!ALLOWED_DOC_MIMES.includes(blob.type)) continue;
        docItems.push({ name: sanitizeFileName(f.name || 'document'), size: blob.size, file: blob });
      }

      const legalDocs = (Array.isArray(b.legalDocs) ? b.legalDocs : [])
        .filter(d => d && LEGAL_DOCS_LIST.some(def => def.id === d.id))
        .map(d => ({
          id:        d.id,
          label:     LEGAL_DOCS_LIST.find(def => def.id === d.id).label,
          present:   !!d.present,
          reference: sanitizeInput(d.reference || '').slice(0, 200),
          detenteur: sanitizeInput(d.detenteur || '').slice(0, 200)
        }));

      const row = {
        id,
        nom:         sanitizeInput(b.nom).slice(0, 200),
        type:        b.type,
        description: sanitizeInput(b.description || '').slice(0, 5000),
        adresse:     sanitizeInput(b.adresse || '').slice(0, 500),
        lat, lng,
        legal_docs:  legalDocs,
        photos:      await uploadFiles(id, 'photos', photoItems, uploaded),
        docs:        await uploadFiles(id, 'docs',   docItems,   uploaded)
      };
      const created = new Date(b.createdAt);
      if (!isNaN(created)) row.created_at = created.toISOString();

      const { error } = await sb.from('biens').insert(row);
      if (error) throw new Error(error.message);
      existingIds.add(id);
      imported++;
    } catch (e) {
      console.error(`Import de "${b.nom}" impossible :`, e);
      await removeStoragePaths(uploaded.map(u => u.path));
    }
  }
  return imported;
}

function importJSON(input) {
  const file = input.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async e => {
    let data;
    try {
      data = JSON.parse(e.target.result);
    } catch (err) {
      return showToast('Erreur de lecture : ' + err.message, 'error');
    }
    if (!data.biens || !Array.isArray(data.biens)) {
      return showToast('Fichier invalide.', 'error');
    }

    showLoader();
    const n = await importBiensList(data.biens);
    hideLoader();
    showToast(`${n} bien(s) importé(s) sur ${data.biens.length}.`, n ? 'success' : '');
    showView('home');
  };
  reader.readAsText(file);
  input.value = '';
}

/** Propose d'envoyer dans l'espace familial les biens de l'ancienne version (localStorage). */
async function proposeMigration() {
  let local = [];
  try {
    if (localStorage.getItem(MIGRATION_KEY)) return;
    const raw = localStorage.getItem(STORAGE_KEY);
    local = raw ? JSON.parse(raw) : [];
  } catch (e) { return; }
  if (!Array.isArray(local) || !local.length) return;

  const ok = confirm(
    `${local.length} bien(s) de l'ancienne version sont enregistrés sur cet appareil.\n\n` +
    'Les envoyer dans l\'espace familial pour que toute la famille les voie ?'
  );
  if (!ok) return;

  showLoader();
  const n = await importBiensList(local);
  hideLoader();
  // On garde les données locales comme sauvegarde, mais on ne repose plus la question
  try { localStorage.setItem(MIGRATION_KEY, new Date().toISOString()); } catch (e) { /* ignore */ }
  showToast(`${n} bien(s) transféré(s) dans l'espace familial.`, 'success');
  showView('home');
}

/* ============================================================
   📄 EXPORT PDF (jsPDF)
============================================================ */
async function exportBienPDF(id) {
  const b = getBiens().find(x => x.id === id);
  if (!b) return showToast('Bien introuvable.', 'error');

  if (typeof window.jspdf === 'undefined') {
    return showToast('jsPDF non chargé. Vérifiez votre connexion internet.', 'error');
  }

  const btn = document.getElementById('btn-pdf-export');
  if (btn) { btn.disabled = true; btn.innerHTML = icon('file-down') + 'Génération…'; }

  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

    const PAGE_W  = 210;
    const MARGIN  = 18;
    const CONTENT = PAGE_W - MARGIN * 2;
    let y = MARGIN;
    const ACCENT = [180, 83, 47];   // terracotta de l'application

    const checkNewPage = (needed = 10) => {
      if (y + needed > 280) { doc.addPage(); y = MARGIN; }
    };
    const drawLine = () => {
      doc.setDrawColor(232, 229, 223);
      doc.setLineWidth(0.4);
      doc.line(MARGIN, y, PAGE_W - MARGIN, y);
      y += 5;
    };
    const sectionTitle = (title) => {
      checkNewPage(14);
      doc.setFillColor(...ACCENT);
      doc.roundedRect(MARGIN, y, CONTENT, 8, 2, 2, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(10); doc.setFont('helvetica', 'bold');
      doc.text(title, MARGIN + 4, y + 5.5);
      doc.setTextColor(30, 30, 30);
      y += 12;
    };
    const field = (label, value) => {
      if (!value) return;
      checkNewPage(8);
      doc.setFontSize(9); doc.setFont('helvetica', 'bold');
      doc.setTextColor(138, 135, 128);
      doc.text(label + ' :', MARGIN, y);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(26, 25, 22);
      const lines = doc.splitTextToSize(String(value), CONTENT - 35);
      doc.text(lines, MARGIN + 35, y);
      y += lines.length * 5 + 2;
    };

    // En-tête
    doc.setFillColor(...ACCENT);
    doc.rect(0, 0, PAGE_W, 22, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(16); doc.setFont('helvetica', 'bold');
    doc.text('ImmoFamille', MARGIN, 14);
    doc.setFontSize(10); doc.setFont('helvetica', 'normal');
    doc.text('Fiche de bien immobilier', PAGE_W - MARGIN, 14, { align: 'right' });
    doc.setTextColor(30, 30, 30);
    y = 30;

    // Titre du bien
    const t = typeInfo(b.type);
    doc.setFontSize(18); doc.setFont('helvetica', 'bold');
    doc.text(b.nom, MARGIN, y);
    y += 7;
    doc.setFontSize(10); doc.setFont('helvetica', 'normal');
    doc.setTextColor(138, 135, 128);
    doc.text(`${t.label}`, MARGIN, y);
    const statut = getStatut(b);
    const isComplet = statut.classe === 'statut-complet';
    doc.setTextColor(isComplet ? 46 : 217, isComplet ? 125 : 83, isComplet ? 82 : 79);
    doc.text(statut.texte, PAGE_W - MARGIN, y, { align: 'right' });
    doc.setTextColor(30, 30, 30);
    y += 8;
    drawLine();

    // Infos
    sectionTitle('Informations generales');
    field('Nom',     b.nom);
    field('Type',    t.label);
    field('Adresse', b.adresse);
    if (b.lat != null) field('GPS', `${b.lat.toFixed(6)}, ${b.lng.toFixed(6)}`);
    field('Ajoute le', new Date(b.createdAt).toLocaleDateString('fr-FR'));
    if (b.updatedAt) field('Modifie le', new Date(b.updatedAt).toLocaleDateString('fr-FR'));
    y += 3;

    // Description
    if (b.description) {
      sectionTitle('Description');
      doc.setFontSize(10); doc.setFont('helvetica', 'normal');
      const lines = doc.splitTextToSize(b.description, CONTENT);
      lines.forEach(line => { checkNewPage(7); doc.text(line, MARGIN, y); y += 5.5; });
      y += 3;
    }

    // Documents légaux
    sectionTitle('Documents legaux');
    const legalDocs = b.legalDocs || [];
    LEGAL_DOCS_LIST.forEach(def => {
      const d = legalDocs.find(x => x.id === def.id) || { present: false };
      checkNewPage(12);
      const icon  = d.present ? '[OK]' : '[--]';
      const color = d.present ? [46,125,82] : [217,83,79];
      doc.setFontSize(9);
      doc.setTextColor(...color); doc.setFont('helvetica', 'bold');
      doc.text(icon, MARGIN, y);
      doc.setTextColor(30,30,30); doc.setFont('helvetica', 'normal');
      doc.text(def.label, MARGIN + 12, y);
      if (d.present) {
        const meta = [];
        if (d.reference) meta.push('Ref : ' + d.reference);
        if (d.detenteur) meta.push('Detenteur : ' + d.detenteur);
        if (meta.length) {
          doc.setTextColor(138,135,128); doc.setFontSize(8);
          doc.text(meta.join(' - '), MARGIN + 12, y + 4);
          y += 4;
        }
      }
      y += 7;
    });
    y += 3;

    // Fichiers joints
    if (b.docs && b.docs.length) {
      sectionTitle('Fichiers joints');
      b.docs.forEach(d => {
        checkNewPage(8);
        doc.setFontSize(9); doc.setFont('helvetica', 'normal');
        doc.setTextColor(30,30,30);
        doc.text(`- ${d.name}  (${formatSize(d.size)})`, MARGIN, y);
        y += 6;
      });
      y += 3;
    }

    // Photos
    if (b.photos && b.photos.length) {
      sectionTitle('Photos');
      const IMG_W = (CONTENT - 8) / 2;
      const IMG_H = IMG_W * 0.65;
      let col = 0;
      let rowY = y;

      for (let i = 0; i < b.photos.length; i++) {
        const photo = b.photos[i];
        let dataUrl = '';
        try { dataUrl = photo.path ? await pathToDataUrl(photo.path) : (photo.dataUrl || ''); }
        catch (e) { console.warn('Photo non chargée pour le PDF :', e); }
        const fmt = dataUrl.startsWith('data:image/png') ? 'PNG'
                  : dataUrl.startsWith('data:image/webp') ? 'WEBP' : 'JPEG';
        const x = MARGIN + col * (IMG_W + 8);

        checkNewPage(IMG_H + 8);
        if (col === 0) rowY = y;

        try {
          if (!dataUrl) throw new Error('photo indisponible');
          doc.addImage(dataUrl, fmt, x, rowY, IMG_W, IMG_H, '', 'MEDIUM');
        } catch(e) {
          doc.setFillColor(240, 238, 233);
          doc.roundedRect(x, rowY, IMG_W, IMG_H, 2, 2, 'F');
          doc.setFontSize(8); doc.setTextColor(138,135,128);
          doc.text('Image non disponible', x + IMG_W/2, rowY + IMG_H/2, { align: 'center' });
        }

        col++;
        if (col === 2) {
          col = 0;
          y = rowY + IMG_H + 6;
        }
      }
      if (col !== 0) y = rowY + IMG_H + 6;
    }

    // Pied de page
    const totalPages = doc.internal.getNumberOfPages();
    for (let p = 1; p <= totalPages; p++) {
      doc.setPage(p);
      doc.setFontSize(8); doc.setTextColor(138,135,128);
      doc.setFont('helvetica', 'normal');
      doc.text(
        `ImmoFamille · Genere le ${new Date().toLocaleDateString('fr-FR')} · Page ${p}/${totalPages}`,
        PAGE_W / 2, 292, { align: 'center' }
      );
    }

    const fileName = `immofamille_${b.nom.replace(/[^a-zA-Z0-9]/g,'_')}_${new Date().toISOString().slice(0,10)}.pdf`;
    doc.save(fileName);
    showToast('PDF exporté !', 'success');

  } catch(err) {
    console.error('Erreur PDF:', err);
    showToast('Erreur PDF : ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = icon('file-down') + 'Fiche PDF'; }
  }
}

/* ============================================================
   🔐 CONNEXION & DEMANDE D'ACCÈS
   - Un proche envoie nom / prénom / e-mail      → demande "en_attente"
   - L'admin l'accepte                           → un code lui est envoyé par e-mail
   - 1re connexion : code (ou lien) de l'e-mail  → il crée son mot de passe
   - Ensuite : e-mail + mot de passe, sur n'importe quel appareil
   - Mot de passe oublié : nouveau code par e-mail → nouveau mot de passe
============================================================ */
function configOk() {
  const c = window.IMMO_CONFIG || {};
  return typeof c.SUPABASE_URL === 'string' && /^https:\/\//.test(c.SUPABASE_URL) &&
         !c.SUPABASE_URL.includes('VOTRE-PROJET') &&
         typeof c.SUPABASE_ANON_KEY === 'string' && c.SUPABASE_ANON_KEY.length > 20;
}

function appUrl() {
  return window.location.origin + window.location.pathname;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Connexion faite avec un code / lien reçu par e-mail : on propose alors de
// (re)définir le mot de passe. Partagé entre onglets (le lien s'ouvre souvent ailleurs).
const EMAIL_LOGIN_KEY = 'immofamille_connexion_par_email';

function markEmailLogin(on) {
  try {
    if (on) localStorage.setItem(EMAIL_LOGIN_KEY, '1');
    else    localStorage.removeItem(EMAIL_LOGIN_KEY);
  } catch (e) { /* ignore */ }
}

function isEmailLogin() {
  try { return localStorage.getItem(EMAIL_LOGIN_KEY) === '1'; } catch (e) { return false; }
}

function setAuthTab(tab) {
  ['login', 'demande'].forEach(t =>
    document.getElementById('tab-' + t).classList.toggle('active', t === tab || (tab === 'otp' && t === 'login')));
  ['login', 'demande', 'otp'].forEach(t =>
    document.getElementById('pane-' + t).classList.toggle('active', t === tab));
  // Pendant l'attente de l'e-mail, l'écran ne montre que cette étape
  document.querySelector('#view-auth .gate-card').classList.toggle('otp-mode', tab === 'otp');
  setAuthMessage('');
  if (tab !== 'otp') stopWaitingForEmail();
}

function setAuthMessage(html, type = '') {
  const el = document.getElementById('auth-message');
  if (!el) return;
  el.className = 'notice' + (html ? ' visible ' + type : '');
  el.innerHTML = html;
}

function setBusy(btnId, busy, label) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  if (busy) { btn.dataset.label = btn.textContent; btn.textContent = label; }
  else if (btn.dataset.label) btn.textContent = btn.dataset.label;
  btn.disabled = busy;
}

function isRateLimited(error) {
  return !!error && (error.status === 429 || /rate limit|security purposes/i.test(error.message || ''));
}

function authErrorMessage(error) {
  if (!error) return '';
  if (isRateLimited(error)) return 'Trop de tentatives. Patientez une minute avant de réessayer.';
  return error.message || 'Erreur inconnue.';
}

function goToLogin(email) {
  setAuthTab('login');
  document.getElementById('login-email').value = email || '';
  document.getElementById('login-password').focus();
}

function togglePassword(inputId, btn) {
  const input = document.getElementById(inputId);
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.innerHTML = icon(show ? 'eye-off' : 'eye');
  btn.setAttribute('aria-label', show ? 'Masquer le mot de passe' : 'Afficher le mot de passe');
}

/** L'adresse peut-elle se connecter ? Sinon, explique pourquoi et renvoie false. */
async function checkEmailAllowed(email) {
  const { data: statut, error } = await sb.rpc('statut_email', { p_email: email });
  if (error) throw error;
  if (statut === 'approuve') return true;

  if (statut === 'en_attente') {
    setAuthMessage('Votre demande est <strong>en attente</strong> : l\'administrateur doit encore la valider. Vous recevrez alors un code par e-mail.');
  } else if (statut === 'refuse') {
    setAuthMessage('Votre demande a été refusée. Contactez l\'administrateur de la famille.', 'error');
  } else {
    setAuthMessage('Aucune demande pour cette adresse. ' +
      '<button type="button" class="link-btn" onclick="setAuthTab(\'demande\')">Faire une demande d\'accès</button>', 'error');
  }
  return false;
}

// Pendant une connexion lancée ici, on ignore l'événement « connecté » de Supabase
let signingIn = false;

async function loginWithPassword() {
  const email    = document.getElementById('login-email').value.trim().toLowerCase();
  const password = document.getElementById('login-password').value;
  if (!EMAIL_RE.test(email)) return setAuthMessage('Adresse e-mail invalide.', 'error');
  if (!password)             return setAuthMessage('Saisissez votre mot de passe.', 'error');

  setBusy('btn-login', true, 'Connexion…');
  signingIn = true;
  try {
    if (!(await checkEmailAllowed(email))) return;
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      if (/invalid login credentials/i.test(error.message || '')) {
        return setAuthMessage('E-mail ou mot de passe incorrect.<br>' +
          'Première connexion ? Utilisez le bouton <strong>« Première connexion »</strong> ci-dessous.', 'error');
      }
      if (/not confirmed/i.test(error.message || '')) {
        return setAuthMessage('Votre adresse n\'est pas encore confirmée : utilisez <strong>« Première connexion »</strong>.', 'error');
      }
      throw error;
    }
    markEmailLogin(false);
    session = data.session;
    document.getElementById('login-password').value = '';
    await checkMembership();
  } catch (e) {
    setAuthMessage(esc(authErrorMessage(e)), 'error');
  } finally {
    signingIn = false;
    setBusy('btn-login', false);
  }
}

let otpEmail = '';

/** « Première connexion » ou « Mot de passe oublié » : envoie un code par e-mail. */
async function startEmailCode(purpose) {
  const email = document.getElementById('login-email').value.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    document.getElementById('login-email').focus();
    return setAuthMessage(purpose === 'reset'
      ? 'Saisissez d\'abord votre adresse e-mail ci-dessus, puis cliquez sur « Mot de passe oublié ».'
      : 'Saisissez d\'abord votre adresse e-mail ci-dessus, puis cliquez sur « Première connexion ».', 'error');
  }
  try {
    if (!(await checkEmailAllowed(email))) return;
    await requestEmailCode(email);
  } catch (e) {
    setAuthMessage(esc(authErrorMessage(e)), 'error');
  }
}

async function requestEmailCode(email) {
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: appUrl(), shouldCreateUser: true }
  });
  // Un code vient déjà d'être envoyé (par exemple par l'admin) : on laisse le saisir
  if (error && !isRateLimited(error)) throw error;
  showOtpPane(email, error ? 'Un e-mail vous a été envoyé il y a moins d\'une minute : utilisez son code ou son lien.' : '');
}

/** Écran « Vérifiez votre boîte mail », qui passe tout seul à la suite une fois confirmé. */
function showOtpPane(email, notice) {
  otpEmail = email;
  document.getElementById('otp-intro').innerHTML =
    `Un e-mail a été envoyé à <strong>${esc(email)}</strong>. Cliquez sur le lien qu'il contient pour confirmer votre adresse.`;
  document.getElementById('otp-code').value = '';
  setAuthTab('otp');
  if (notice) setAuthMessage(esc(notice));
  waitForEmailConfirmation();
}

async function resendCode() {
  if (!otpEmail) return setAuthTab('login');
  const { error } = await sb.auth.signInWithOtp({
    email: otpEmail,
    options: { emailRedirectTo: appUrl(), shouldCreateUser: true }
  });
  if (error) return setAuthMessage(esc(authErrorMessage(error)), 'error');
  setAuthMessage('Nouvel e-mail envoyé. Utilisez le code le plus récent.', 'success');
}

/** Code saisi à la main (dans ce même onglet). */
async function verifyEmailCode() {
  const token = document.getElementById('otp-code').value.replace(/\s/g, '');
  if (!/^\d{6,10}$/.test(token)) return setAuthMessage('Saisissez le code à chiffres reçu par e-mail.', 'error');

  setBusy('btn-otp', true, 'Vérification…');
  signingIn = true;
  try {
    const { data, error } = await sb.auth.verifyOtp({ email: otpEmail, token, type: 'email' });
    if (error) {
      const expired = /expired|invalid/i.test(error.message || '');
      return setAuthMessage(expired ? 'Code incorrect ou expiré. Vérifiez-le, ou renvoyez un code.' : esc(authErrorMessage(error)), 'error');
    }
    markEmailLogin(true);
    session = data.session;
    stopWaitingForEmail();
    showToast('Adresse e-mail confirmée', 'success');
    await checkMembership();
  } finally {
    signingIn = false;
    setBusy('btn-otp', false);
  }
}

/* Lien de l'e-mail ouvert dans un autre onglet : on le détecte ici
   (événement Supabase, changement du stockage, retour sur l'onglet, et vérification régulière) */
let waitTimer = null;

function waitForEmailConfirmation() {
  stopWaitingForEmail();
  waitTimer = setInterval(detectExternalLogin, 2500);
}

function stopWaitingForEmail() {
  if (waitTimer) clearInterval(waitTimer);
  waitTimer = null;
}

async function detectExternalLogin() {
  if (!sb || signingIn) return;
  const { data } = await sb.auth.getSession();
  const email = data.session && data.session.user ? data.session.user.email : null;
  const known = session && session.user ? session.user.email : null;
  if (email && email !== known) {
    session = data.session;
    stopWaitingForEmail();
    showToast('Adresse e-mail confirmée', 'success');
    checkMembership();
  } else if (!email && known) {
    session = null;
    resetSessionState();
    showView('auth');
  }
}

async function sendDemande() {
  const prenom = sanitizeInput(document.getElementById('dem-prenom').value).slice(0, 80);
  const nom    = sanitizeInput(document.getElementById('dem-nom').value).slice(0, 80);
  const email  = document.getElementById('dem-email').value.trim().toLowerCase();

  if (!prenom || !nom)       return setAuthMessage('Nom et prénom obligatoires.', 'error');
  if (!EMAIL_RE.test(email)) return setAuthMessage('Adresse e-mail invalide.', 'error');

  setBusy('btn-demande', true, 'Envoi…');
  try {
    const { data: res, error } = await sb.rpc('demander_acces', { p_nom: nom, p_prenom: prenom, p_email: email });
    if (error) throw error;

    const loginBtn = `<button type="button" class="link-btn" onclick="goToLogin('${escAttr(email)}')">Se connecter</button>`;
    const messages = {
      envoyee:          [`Merci ${esc(prenom)}, votre demande est envoyée !<br>Dès que l'administrateur l'aura acceptée, vous recevrez un code par e-mail à <strong>${esc(email)}</strong> pour créer votre mot de passe.`, 'success'],
      en_attente:       ['Une demande existe déjà pour cette adresse. Elle attend la validation de l\'administrateur.', ''],
      approuve:         [`Cette adresse est déjà acceptée. ${loginBtn}`, 'success'],
      refuse:           ['Une demande pour cette adresse a été refusée. Contactez l\'administrateur de la famille.', 'error'],
      complet:          [`La famille est complète (${MAX_MEMBRES} membres maximum). Contactez l'administrateur.`, 'error'],
      trop_de_demandes: ['Trop de demandes sont en attente. Réessayez plus tard.', 'error']
    };
    const [html, type] = messages[res] || ['Réponse inattendue du serveur.', 'error'];
    setAuthMessage(html, type);
    if (res === 'envoyee') {
      ['dem-prenom', 'dem-nom', 'dem-email'].forEach(id => { document.getElementById(id).value = ''; });
    }
  } catch (e) {
    setAuthMessage(esc(authErrorMessage(e)), 'error');
  } finally {
    setBusy('btn-demande', false);
  }
}

async function logout() {
  if (sb) await sb.auth.signOut();
  resetSessionState();
  showView('auth');
}

function resetSessionState() {
  otpEmail       = '';
  accessGranted  = false;
  currentMember  = null;
  biensCache     = [];
  membresCache   = [];
  markEmailLogin(false);
  stopWaitingForEmail();
  setAuthTab('login');
  ['login-email', 'login-password', 'new-password', 'new-password2'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.body.classList.remove('is-admin');
}

/* Écran générique (attente de validation, configuration manquante…) */
function showMessage(iconName, title, html, actions) {
  document.getElementById('message-icon').innerHTML    = icon(iconName);
  document.getElementById('message-title').textContent = title;
  document.getElementById('message-text').innerHTML    = html;
  document.getElementById('message-actions').innerHTML = actions || '';
  showView('message');
}

/** Après connexion : décide de l'étape suivante selon l'état en base. */
let checking = null;
function checkMembership() {
  // Évite deux vérifications simultanées (ex. événement d'un autre onglet + clic)
  if (!checking) checking = doCheckMembership().finally(() => { checking = null; });
  return checking;
}

async function doCheckMembership() {
  const email = (session && session.user && session.user.email || '').toLowerCase();
  if (!email) return showView('auth');
  accessGranted = false;

  const { data: etat, error } = await sb.rpc('mon_etat');
  if (error) {
    return showMessage('triangle-alert', 'Connexion impossible', esc(error.message),
      `<button class="btn btn-primary" onclick="checkMembership()">Réessayer</button>
       <button class="btn btn-ghost" onclick="logout()">Se déconnecter</button>`);
  }
  currentMember = etat.statut === 'inconnu' ? null : etat;

  const actions = `<button class="btn btn-primary" onclick="checkMembership()">Vérifier à nouveau</button>
                   <button class="btn btn-ghost" onclick="logout()">Se déconnecter</button>`;
  if (!currentMember) {
    return showMessage('search', 'Aucune demande trouvée',
      `Aucune demande d'accès n'existe pour <strong>${esc(email)}</strong>.<br>Déconnectez-vous puis utilisez « Demander l'accès ».`, actions);
  }
  if (etat.statut === 'refuse') {
    return showMessage('user-x', 'Demande refusée',
      'Votre demande d\'accès a été refusée. Contactez l\'administrateur de la famille.', actions);
  }
  if (etat.statut !== 'approuve') {
    return showMessage('hourglass', 'Demande en attente',
      `Bonjour ${esc(etat.prenom)} ! Votre demande est bien reçue.<br>L'administrateur doit la valider avant que vous puissiez accéder aux biens.`, actions);
  }

  // Membre accepté : a-t-il déjà un mot de passe ?
  const { data: u } = await sb.auth.getUser();
  const meta = (u && u.user && u.user.user_metadata) || {};
  if (!meta.mdp_defini) return showPasswordStep('create');
  if (isEmailLogin())   return showPasswordStep('reset');

  accessGranted = true;
  return enterApp();
}

/* ------------------------------------------------------------
   Création / changement du mot de passe
   'create' → 1re connexion · 'reset' → connecté par code e-mail (oubli)
------------------------------------------------------------ */
const PASSWORD_RULES = {
  length: p => p.length >= 8,
  letter: p => /[a-zA-ZÀ-ÿ]/.test(p),
  digit:  p => /\d/.test(p)
};

function showPasswordStep(mode) {
  const reset = mode === 'reset';
  document.getElementById('password-title').textContent = reset ? 'Nouveau mot de passe' : 'Créez votre mot de passe';
  document.getElementById('password-text').innerHTML = reset
    ? `Bonjour ${esc(currentMember.prenom)}, vous vous êtes connecté avec un code reçu par e-mail. Choisissez un nouveau mot de passe, ou gardez l'actuel.`
    : `Bienvenue ${esc(currentMember.prenom)} ! Choisissez le mot de passe que vous utiliserez pour vous connecter, sur tous vos appareils.`;
  document.getElementById('btn-keep-password').style.display = reset ? '' : 'none';
  document.getElementById('keep-sep').style.display          = reset ? '' : 'none';
  document.getElementById('password-username').value = currentMember.email || '';
  ['new-password', 'new-password2'].forEach(id => { document.getElementById(id).value = ''; });
  updatePasswordRules();
  setPasswordMessage('');
  showView('password');
  setTimeout(() => document.getElementById('new-password').focus(), 200);
}

function setPasswordMessage(html, type = '') {
  const el = document.getElementById('password-message');
  el.className = 'notice' + (html ? ' visible ' + type : '');
  el.innerHTML = html;
}

function updatePasswordRules() {
  const pwd = document.getElementById('new-password').value;
  let ok = true;
  document.querySelectorAll('#password-rules li').forEach(li => {
    const pass = PASSWORD_RULES[li.dataset.rule](pwd);
    ok = ok && pass;
    if (li.classList.contains('ok') !== pass || !li.querySelector('.icon')) {
      li.classList.toggle('ok', pass);
      li.querySelector('svg, i').outerHTML = icon(pass ? 'circle-check' : 'circle');
    }
  });
  return ok;
}

async function submitPassword() {
  const pwd  = document.getElementById('new-password').value;
  const pwd2 = document.getElementById('new-password2').value;
  if (!updatePasswordRules()) return setPasswordMessage('Le mot de passe doit contenir au moins 8 caractères, dont une lettre et un chiffre.', 'error');
  if (pwd !== pwd2)           return setPasswordMessage('Les deux mots de passe ne correspondent pas.', 'error');

  setBusy('btn-password', true, 'Enregistrement…');
  try {
    const { error } = await sb.auth.updateUser({ password: pwd, data: { mdp_defini: true } });
    if (error) {
      if (/different from the old/i.test(error.message || '')) {
        return setPasswordMessage('C\'est déjà votre mot de passe actuel. Choisissez-en un autre, ou gardez l\'actuel.', 'error');
      }
      return setPasswordMessage(esc(authErrorMessage(error)), 'error');
    }
    markEmailLogin(false);
    showToast('Mot de passe enregistré', 'success');
    await checkMembership();
  } finally {
    setBusy('btn-password', false);
  }
}

function keepCurrentPassword() {
  markEmailLogin(false);
  checkMembership();
}

function enterApp() {
  const m = currentMember;
  document.body.classList.toggle('is-admin', isAdmin());
  document.getElementById('user-avatar').textContent =
    (String(m.prenom || '?').charAt(0) + String(m.nom || '').charAt(0)).toUpperCase();
  document.getElementById('user-chip').textContent  = `${m.prenom} ${m.nom}`;
  document.getElementById('user-email').textContent = m.email || '';
  showView('home');
  if (isAdmin()) setTimeout(proposeMigration, 800);
}

/* Menu du compte (avatar en haut à droite) */
function toggleUserMenu(event) {
  if (event) event.stopPropagation();
  const menu = document.getElementById('user-menu');
  const open = !menu.classList.contains('open');
  menu.classList.toggle('open', open);
  document.getElementById('user-btn').setAttribute('aria-expanded', open ? 'true' : 'false');
}

function closeUserMenu() {
  const menu = document.getElementById('user-menu');
  if (!menu) return;
  menu.classList.remove('open');
  document.getElementById('user-btn').setAttribute('aria-expanded', 'false');
}

document.addEventListener('click', e => {
  if (!e.target.closest('.user-menu')) closeUserMenu();
});

/* ============================================================
   👑 ADMINISTRATION DES MEMBRES
============================================================ */
let comptes = {};   // membre_id → { compte_cree, mot_de_passe, derniere_connexion }

async function loadMembres() {
  if (!isAdmin()) return;
  const [res, secu] = await Promise.all([
    sb.from('membres').select('*').order('created_at'),
    sb.rpc('etat_comptes')
  ]);
  if (res.error) return showToast('Impossible de charger les membres : ' + res.error.message, 'error');
  membresCache = res.data;
  comptes = {};
  (secu.data || []).forEach(x => { comptes[x.membre_id] = x; });
  updateAdminBadge();
}

function secuBadge(m) {
  if (m.statut !== 'approuve' || m.role === 'admin') return '';
  const x = comptes[m.id] || {};
  if (x.mot_de_passe) return `<span class="tag tag-ok">${icon('shield-check')}Compte activé</span>`;
  if (x.compte_cree)  return `<span class="tag tag-warn">${icon('mail')}Invitation envoyée</span>`;
  return `<span class="tag tag-neutral">${icon('clock')}Pas encore invité</span>`;
}

function updateAdminBadge() {
  const n = membresCache.filter(m => m.statut === 'en_attente').length;
  const badge = document.getElementById('admin-badge');
  if (badge) {
    badge.textContent = n;
    badge.classList.toggle('visible', n > 0);
  }
  const dot = document.getElementById('avatar-dot');
  if (dot) dot.classList.toggle('visible', n > 0);
  const menuCount = document.getElementById('menu-admin-count');
  if (menuCount) menuCount.textContent = n ? `${n} en attente` : '';
}

function membreItem(m, actions) {
  const initiales = (String(m.prenom || '?').charAt(0) + String(m.nom || '').charAt(0)).toUpperCase();
  const date = new Date(m.created_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
  return `<div class="member-item${m.role === 'admin' ? ' is-admin' : ''}">
    <div class="member-avatar">${esc(initiales)}</div>
    <div class="member-info">
      <div class="member-name">${esc(m.prenom)} ${esc(m.nom)}${m.role === 'admin' ? `<span class="tag tag-neutral">${icon('crown')}Admin</span>` : ''}${secuBadge(m)}</div>
      <div class="member-meta">${esc(m.email)} · demande du ${date}</div>
    </div>
    ${actions ? `<div class="member-actions">${actions}</div>` : ''}
  </div>`;
}

function renderAdmin() {
  const pending  = membresCache.filter(m => m.statut === 'en_attente');
  const membres  = membresCache.filter(m => m.statut === 'approuve')
                     .sort((a, b) => (a.role === 'admin' ? -1 : 0) - (b.role === 'admin' ? -1 : 0));
  const refuses  = membresCache.filter(m => m.statut === 'refuse');
  const complet  = membres.length >= MAX_MEMBRES;

  const pct = Math.round(membres.length / MAX_MEMBRES * 100);
  document.getElementById('quota-bar').style.width = pct + '%';
  document.getElementById('quota-bar').classList.toggle('full', complet);
  document.getElementById('quota-text').textContent =
    `${membres.length} membre${membres.length > 1 ? 's' : ''} sur ${MAX_MEMBRES}` +
    (complet ? ' · famille complète' : ` · ${MAX_MEMBRES - membres.length} place${MAX_MEMBRES - membres.length > 1 ? 's libres' : ' libre'}`);
  document.getElementById('quota-pct').textContent = pct + '%';
  document.getElementById('share-link').value = appUrl();
  document.getElementById('admin-pending-count').textContent = pending.length;

  document.getElementById('admin-pending').innerHTML = pending.length
    ? pending.map(m => membreItem(m,
        `<button class="btn btn-sm btn-success" ${complet ? 'disabled title="Famille complète : retirez d\'abord un membre"' : ''} onclick="decideMembre('${m.id}', 'approuve')">${icon('check')}Accepter</button>
         <button class="btn btn-sm btn-secondary" onclick="decideMembre('${m.id}', 'refuse')">Refuser</button>`)).join('')
    : '<p class="member-empty">Aucune demande en attente.</p>';

  document.getElementById('admin-membres').innerHTML = membres.length
    ? membres.map(m => membreItem(m, m.role === 'admin' ? '' :
        `${(comptes[m.id] || {}).mot_de_passe ? '' : `<button class="btn btn-sm btn-secondary" title="Envoyer à nouveau le code par e-mail" onclick="sendInvite('${m.id}')">${icon('send')}Renvoyer l'invitation</button>`}
         <button class="btn btn-sm btn-ghost" onclick="removeMembre('${m.id}')">Retirer</button>`)).join('')
    : '<p class="member-empty">Aucun membre.</p>';

  document.getElementById('admin-refuses-card').style.display = refuses.length ? '' : 'none';
  document.getElementById('admin-refuses').innerHTML = refuses.map(m => membreItem(m,
    `<button class="btn btn-sm btn-secondary" ${complet ? 'disabled' : ''} onclick="decideMembre('${m.id}', 'approuve')">Accepter</button>
     <button class="btn btn-sm btn-ghost" onclick="removeMembre('${m.id}')">${icon('trash-2')}Effacer</button>`)).join('');

  updateAdminBadge();
}

async function decideMembre(id, statut) {
  const m = membresCache.find(x => x.id === id);
  if (!m) return;
  if (statut === 'refuse' && !confirm(`Refuser la demande de ${m.prenom} ${m.nom} ?`)) return;

  const { data, error } = await sb.from('membres').update({ statut }).eq('id', id).select();
  if (error || !data || !data.length) {
    return showToast('' + (error ? error.message : 'Action refusée.'), 'error');
  }
  await loadMembres();
  renderAdmin();

  if (statut === 'approuve') {
    showToast(`${m.prenom} fait maintenant partie de la famille !`, 'success');
    await sendInvite(id);
  } else {
    showToast(`Demande de ${m.prenom} refusée.`, 'success');
  }
}

async function removeMembre(id) {
  const m = membresCache.find(x => x.id === id);
  if (!m || m.role === 'admin') return;
  const msg = m.statut === 'approuve'
    ? `Retirer ${m.prenom} ${m.nom} de la famille ? Son compte de connexion sera supprimé et il/elle n'aura plus accès aux biens.`
    : `Effacer la demande de ${m.prenom} ${m.nom} ? La personne pourra refaire une demande.`;
  if (!confirm(msg)) return;

  const { data, error } = await sb.from('membres').delete().eq('id', id).select('id');
  if (error || !data || !data.length) {
    return showToast('' + (error ? error.message : 'Action refusée.'), 'error');
  }
  showToast(`${m.prenom} a été retiré(e).`, 'success');
  await loadMembres();
  renderAdmin();
}



/* ------------------------------------------------------------
   Invitation : Supabase envoie au membre un e-mail avec un code
   à 6 chiffres (et un lien) pour créer son mot de passe
------------------------------------------------------------ */
async function sendInvite(id) {
  const m = membresCache.find(x => x.id === id);
  if (!m) return;
  const { error } = await sb.auth.signInWithOtp({
    email: m.email,
    options: { emailRedirectTo: appUrl(), shouldCreateUser: true }
  });
  await loadMembres();
  renderAdmin();
  showInviteModal(m, error);
}

function showInviteModal(m, error) {
  const ok = !error;
  document.getElementById('invite-modal-icon').innerHTML = icon(ok ? 'mail-check' : 'triangle-alert');
  document.getElementById('invite-modal-title').textContent = ok ? 'Invitation envoyée' : 'Invitation non envoyée';
  document.getElementById('invite-modal-text').innerHTML = ok
    ? `<strong>${esc(m.prenom)}</strong> a reçu un e-mail à <strong>${esc(m.email)}</strong> avec un code à 6 chiffres. Pour entrer :`
    : (isRateLimited(error)
        ? `Un e-mail a déjà été envoyé à ${esc(m.prenom)} il y a moins d'une minute. Réessayez dans un instant avec « Renvoyer l'invitation ».`
        : `L'e-mail n'a pas pu partir : ${esc(error.message || 'erreur inconnue')}.<br>Vérifiez le service d'envoi d'e-mails (SMTP) dans Supabase.`);
  document.getElementById('invite-modal-steps').style.display = ok ? '' : 'none';
  const msg =
    `Bonjour ${m.prenom}, ta demande d'accès à ImmoFamille est acceptée ! ` +
    `Tu as reçu un e-mail avec un code à 6 chiffres. Va sur ${appUrl()}, ` +
    `clique sur « Première connexion », saisis le code puis crée ton mot de passe.`;
  document.getElementById('invite-modal-whatsapp').href = 'https://wa.me/?text=' + encodeURIComponent(msg);
  document.getElementById('invite-modal').classList.add('open');
}

function closeInviteModal() {
  document.getElementById('invite-modal').classList.remove('open');
}

function copyShareLink() {
  const url = appUrl();
  const done = () => showToast('Lien copié !', 'success');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(done, () => {
      document.getElementById('share-link').select();
      showToast('Sélectionnez le lien et copiez-le manuellement.', '');
    });
  } else {
    document.getElementById('share-link').select();
    document.execCommand('copy');
    done();
  }
}

/* ============================================================
   🚀 INITIALISATION
============================================================ */
async function initApp() {
  if (!window.supabase || !window.supabase.createClient) {
    return showMessage('wifi-off', 'Connexion impossible',
      'La bibliothèque Supabase n\'a pas pu être chargée. Vérifiez votre connexion internet puis rechargez la page.',
      '<button class="btn btn-primary" onclick="location.reload()">Recharger</button>');
  }
  if (!configOk()) {
    return showMessage('settings', 'Configuration requise',
      'Renseignez l\'adresse et la clé de votre projet Supabase dans le fichier <code>config.js</code>, ' +
      'puis exécutez <code>supabase/schema.sql</code>. Tout est expliqué dans le <code>README.md</code>.');
  }

  sb = window.supabase.createClient(window.IMMO_CONFIG.SUPABASE_URL, window.IMMO_CONFIG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' }
  });

  // Lien de connexion expiré ou déjà utilisé
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const linkError = hash.get('error_description');

  // Lien de l'e-mail ouvert dans cet onglet : on proposera de (re)définir le mot de passe
  if (hash.get('access_token')) markEmailLogin(true);

  const { data } = await sb.auth.getSession();
  session = data.session;

  // Changement de session : lien cliqué dans un autre onglet, déconnexion ailleurs…
  sb.auth.onAuthStateChange((event, newSession) => {
    const prevEmail = session && session.user ? session.user.email : null;
    if (event === 'SIGNED_OUT') {
      session = null;
      resetSessionState();
      showView('auth');
      return;
    }
    if (event === 'SIGNED_IN' && newSession && newSession.user.email !== prevEmail && !signingIn) {
      session = newSession;
      // Ne pas appeler Supabase directement dans ce callback
      setTimeout(() => {
        stopWaitingForEmail();
        showToast('Adresse e-mail confirmée', 'success');
        checkMembership();
      }, 0);
      return;
    }
    if (newSession) session = newSession;
  });

  // Filets de sécurité pour le lien ouvert dans un autre onglet :
  // retour sur cet onglet, et modification du stockage partagé par Supabase
  const onVisible = () => { if (document.visibilityState === 'visible') detectExternalLogin(); };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onVisible);
  window.addEventListener('storage', e => { if (e.key && e.key.startsWith('sb-')) detectExternalLogin(); });

  if (window.location.hash) history.replaceState(null, '', appUrl() + window.location.search);

  if (session) {
    await checkMembership();
  } else {
    showView('auth');
    if (linkError) {
      setAuthMessage('Ce lien de connexion n\'est plus valide (expiré ou déjà utilisé). Demandez-en un nouveau.', 'error');
    }
  }
}

window.addEventListener('load', () => {
  hydrateIcons();
  initTheme();
  setMobileMap(false);
  initApp();
});
