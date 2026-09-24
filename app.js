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
  terrain:   { emoji: '🌿', label: 'Terrain',             color: '#7B9E6B', badgeClass: 'badge-terrain'   },
  maison:    { emoji: '🏠', label: 'Maison',              color: '#5B7FA6', badgeClass: 'badge-maison'    },
  batiment:  { emoji: '🏢', label: 'Bâtiment commercial', color: '#B4783C', badgeClass: 'badge-batiment'  },
  entreprise:{ emoji: '🏭', label: 'Entreprise',          color: '#7850A0', badgeClass: 'badge-entreprise'}
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
  showToast(`✅ Converti : ${result.lat}, ${result.lng}`, 'success');
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
    showToast('⚠️ Impossible de charger les biens : ' + error.message, 'error');
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
  const btn = document.getElementById('theme-btn');
  if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
  try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* ignore */ }
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

function isApproved() { return !!(currentMember && currentMember.statut === 'approuve'); }
function isAdmin()    { return isApproved() && currentMember.role === 'admin'; }

// Connecté mais pas (encore) validé → on garde l'écran de statut (attente / refus)
function fallbackView() {
  return session ? 'message' : 'auth';
}

function goHome() {
  showView(isApproved() ? 'home' : fallbackView());
}

function showView(name, bienId) {
  // Garde-fous : pages réservées aux membres validés / à l'admin
  if (APP_VIEWS.includes(name) && !isApproved()) name = fallbackView();
  if (name === 'admin' && !isAdmin()) name = 'home';

  document.body.classList.toggle('auth-mode', !APP_VIEWS.includes(name));

  showLoader();
  setTimeout(() => {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const target = document.getElementById('view-' + name);
    if (target) target.classList.add('active');
    hideLoader();
    window.scrollTo(0, 0);

    // Afficher le FAB seulement sur la page d'accueil
    const fab = document.getElementById('fab-add');
    if (fab) fab.style.display = (name === 'home') ? '' : 'none';

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
  mapInstance = L.map('map').setView([6.3703, 2.3912], 7);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19
  }).addTo(mapInstance);
  refreshMapMarkers();
  // Rafraîchir la taille après affichage
  setTimeout(() => mapInstance.invalidateSize(), 200);
}

function typeInfo(type) {
  return TYPE_CONFIG[type] || { emoji: '🏠', label: type || 'Bien', color: '#8A8780', badgeClass: 'badge-maison' };
}

function makeMarkerIcon(type) {
  const t = typeInfo(type);
  return L.divIcon({
    className: '',
    html: `<div style="background:${t.color};color:white;border-radius:50% 50% 50% 0;transform:rotate(-45deg);width:34px;height:34px;display:flex;align-items:center;justify-content:center;box-shadow:0 3px 10px rgba(0,0,0,.25);border:2.5px solid white"><span style="transform:rotate(45deg);font-size:14px">${t.emoji}</span></div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 34]
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
    const marker = L.marker([b.lat, b.lng], { icon: makeMarkerIcon(b.type) })
      .addTo(mapInstance)
      .bindPopup(buildPopup(b), { maxWidth: 240 });

    marker.on('click', () => {
      highlightCard(b.id);
      mapInstance.flyTo([b.lat, b.lng], 14, { duration: .8 });
    });

    mapMarkers[b.id] = marker;
    bounds.push([b.lat, b.lng]);
  });

  if (bounds.length === 1)    mapInstance.setView(bounds[0], 14);
  else if (bounds.length > 1) mapInstance.fitBounds(bounds, { padding: [50, 50] });
}

function buildPopup(b) {
  const t = typeInfo(b.type);
  const r = parseInt(t.color.slice(1,3),16),
        g = parseInt(t.color.slice(3,5),16),
        bl = parseInt(t.color.slice(5,7),16);
  const badgeStyle = `background:rgba(${r},${g},${bl},.15);color:${t.color}`;
  return `<div class="map-popup">
    <strong>${esc(b.nom)}</strong>
    <span class="popup-badge" style="${badgeStyle}">${t.emoji} ${t.label}</span>
    ${b.adresse ? `<br><small style="color:#8A8780;margin-top:4px;display:block">📍 ${esc(b.adresse)}</small>` : ''}
    <a class="voir-btn" href="#" onclick="showView('detail','${b.id}');return false;">Voir le détail →</a>
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
  let biens    = getBiens();

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
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  const countBadge = document.getElementById('count-badge');
  if (countBadge) countBadge.textContent = biens.length;

  const container = document.getElementById('biens-list');
  if (!container) return;

  if (!biens.length) {
    const msg = search
      ? `Aucun résultat pour "<strong>${esc(search)}</strong>"`
      : 'Aucun bien trouvé.<br>Cliquez sur <strong>＋ Ajouter</strong> pour commencer.';
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">🏡</div><p>${msg}</p></div>`;
    return;
  }

  container.innerHTML = biens.map(b => {
    const t       = typeInfo(b.type);
    const statut  = getStatut(b);
    const imgHtml = b.photos && b.photos.length
      ? `<img class="bien-card-img" src="${escAttr(photoSrc(b.photos[0]))}" alt="${esc(b.nom)}" loading="lazy"/>`
      : `<div class="bien-card-img-placeholder">${t.emoji}</div>`;

    return `<div class="bien-card" id="card-${b.id}" onclick="showView('detail','${b.id}')">
      ${imgHtml}
      <div class="bien-card-body">
        <div class="bien-card-top">
          <div class="bien-card-name">${esc(b.nom)}</div>
          <span class="badge ${t.badgeClass}">${t.emoji} ${t.label}</span>
        </div>
        ${b.adresse ? `<div class="bien-card-loc">📍 ${esc(b.adresse)}</div>` : ''}
        <span class="statut-badge ${statut.classe}">${statut.icone} ${statut.texte}</span>
      </div>
    </div>`;
  }).join('');
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
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 19
    }).addTo(mapPicker);

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
  pickerMarker = L.marker([lat, lng]).addTo(mapPicker)
    .bindPopup('📍 Position sélectionnée').openPopup();
  mapPicker.setView([lat, lng], 14);
}

/* ============================================================
   📡 GÉOLOCALISATION
============================================================ */
function useMyLocation() {
  const btn = document.getElementById('btn-geo');

  if (!navigator.geolocation) {
    return showToast('⚠️ Géolocalisation non supportée par ce navigateur.', 'error');
  }

  btn.textContent = '⏳ Localisation…';
  btn.classList.add('loading');

  navigator.geolocation.getCurrentPosition(
    pos => {
      btn.textContent = '📡 Utiliser ma position';
      btn.classList.remove('loading');
      setPickerPosition(pos.coords.latitude, pos.coords.longitude);
      showToast('✅ Position détectée !', 'success');
    },
    err => {
      btn.textContent = '📡 Utiliser ma position';
      btn.classList.remove('loading');
      const msgs = {
        1: 'Permission refusée. Autorisez la localisation dans votre navigateur.',
        2: 'Position indisponible.',
        3: 'Délai dépassé. Réessayez.'
      };
      showToast('⚠️ ' + (msgs[err.code] || 'Erreur de géolocalisation.'), 'error');
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
      return showToast(`⚠️ "${sanitizeFileName(file.name)}" n'est pas une image valide (JPEG, PNG, WEBP, GIF).`, 'error');
    }
    if (file.size > MAX_IMG_SIZE) {
      return showToast(`⚠️ "${sanitizeFileName(file.name)}" dépasse 5 Mo.`, 'error');
    }
    if (formPhotos.length >= MAX_PHOTOS) {
      return showToast(`⚠️ Maximum ${MAX_PHOTOS} photos.`, 'error');
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
      <button type="button" class="remove-btn" onclick="removePhoto(${i})">✕</button>
    </div>`
  ).join('');

  const rem = MAX_PHOTOS - formPhotos.length;
  document.getElementById('photo-counter').textContent = formPhotos.length === 0
    ? `${MAX_PHOTOS} photos maximum`
    : `${formPhotos.length}/${MAX_PHOTOS} · encore ${rem} possible(s)`;
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
      return showToast(`⚠️ "${sanitizeFileName(file.name)}" : type non autorisé (PDF, image, Word).`, 'error');
    }
    if (file.size > MAX_DOC_SIZE) {
      return showToast(`⚠️ "${sanitizeFileName(file.name)}" dépasse 10 Mo.`, 'error');
    }
    if (formDocs.length >= MAX_DOCS) {
      return showToast(`⚠️ Maximum ${MAX_DOCS} documents.`, 'error');
    }

    formDocs.push({ name: sanitizeFileName(file.name), size: file.size, file });
  });
  renderDocPreviews();
  document.getElementById('f-docs').value = '';
}

function renderDocPreviews() {
  const container = document.getElementById('doc-preview');
  container.innerHTML = formDocs.map((d, i) =>
    `<div class="doc-item">
      <span class="doc-icon">${docIcon(d.name)}</span>
      <span class="doc-name">${esc(d.name)}</span>
      <span class="doc-size">${formatSize(d.size)}</span>
      <button type="button" class="remove-doc" onclick="removeDoc(${i})">✕</button>
    </div>`
  ).join('');

  const rem = MAX_DOCS - formDocs.length;
  document.getElementById('doc-counter').textContent = formDocs.length === 0
    ? `${MAX_DOCS} documents maximum`
    : `${formDocs.length}/${MAX_DOCS} · encore ${rem} possible(s)`;
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

  if (presents === total) {
    return { texte: 'Complet', icone: '✅', classe: 'statut-complet' };
  }
  return {
    texte: `Incomplet (${presents}/${total})`,
    icone: '⚠️',
    classe: 'statut-incomplet'
  };
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
        <span class="checklist-status">${checked ? '✅' : '—'}</span>
      </div>
      <div class="checklist-fields">
        <input type="text" class="checklist-input" id="ref-${def.id}"
               placeholder="Référence / Numéro" value="${escAttr(ref)}"/>
        <input type="text" class="checklist-input" id="det-${def.id}"
               placeholder="Détenteur" value="${escAttr(det)}"/>
      </div>
    </div>`;
  }).join('');

  updateChecklistProgress();
}

function onChecklistChange(docId, checked) {
  const item = document.getElementById('cli-' + docId);
  if (!item) return;
  const status = item.querySelector('.checklist-status');
  if (checked) {
    item.classList.add('has-doc');
    if (status) status.textContent = '✅';
  } else {
    item.classList.remove('has-doc');
    if (status) status.textContent = '—';
  }
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

  if (bar)   bar.style.width = pct + '%';
  if (text)  text.textContent = `${presents} document${presents > 1 ? 's' : ''} sur ${total} présent${presents > 1 ? 's' : ''}`;
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
  if (!nom)        return showToast('⚠️ Veuillez saisir un nom.', 'error');
  if (!type)       return showToast('⚠️ Veuillez choisir un type.', 'error');
  if (!desc)       return showToast('⚠️ Veuillez saisir une description.', 'error');
  if (!lat || !lng) return showToast('⚠️ Veuillez définir la position GPS sur la carte.', 'error');

  const latF = parseFloat(lat);
  const lngF = parseFloat(lng);
  if (isNaN(latF) || latF < -90  || latF > 90)  return showToast('⚠️ Latitude invalide.', 'error');
  if (isNaN(lngF) || lngF < -180 || lngF > 180) return showToast('⚠️ Longitude invalide.', 'error');

  const old = editingId ? getBiens().find(b => b.id === editingId) : null;
  if (editingId && !old) return showToast('⚠️ Bien introuvable.', 'error');

  const id       = editingId || newId();
  const uploaded = [];
  const saveBtn  = document.getElementById('btn-save');
  saving = true;
  showLoader();
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '⏳ Enregistrement…'; }

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

    showToast(editingId ? '✅ Bien modifié !' : '✅ Bien enregistré !', 'success');
    editingId  = null;
    formPhotos = [];
    formDocs   = [];
    showView('home');
  } catch (e) {
    console.error('Erreur sauvegarde :', e);
    // Annuler les envois de cette tentative pour ne pas laisser de fichiers orphelins
    await removeStoragePaths(uploaded.map(u => u.path));
    uploaded.forEach(u => { delete u.item.path; });
    showToast('⚠️ Enregistrement impossible : ' + e.message, 'error');
  } finally {
    saving = false;
    hideLoader();
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '💾 Enregistrer'; }
  }
}

/* ============================================================
   🔄 RESET / PRÉ-REMPLISSAGE FORMULAIRE
============================================================ */
function resetForm(bienId) {
  editingId = bienId || null;

  document.getElementById('form-title').textContent =
    bienId ? '✏️ Modifier le bien' : '✨ Ajouter un bien';
  document.getElementById('form-subtitle').textContent =
    bienId ? 'Modifiez les informations de ce bien.' : 'Renseignez les informations de votre bien.';

  // Reset des erreurs
  const dmsErr = document.getElementById('dms-error');
  if (dmsErr) { dmsErr.textContent = ''; dmsErr.classList.remove('visible'); }

  if (bienId) {
    // PRÉ-REMPLISSAGE
    const b = getBiens().find(x => x.id === bienId);
    if (!b) {
      showToast('⚠️ Bien introuvable.', 'error');
      showView('home');
      return;
    }
    document.getElementById('f-nom').value     = b.nom || '';
    document.getElementById('f-type').value    = b.type || '';
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
    ['f-nom','f-type','f-desc','f-adresse','f-lat','f-lng','f-dms'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
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
    showToast('⚠️ Bien introuvable.', 'error');
    showView('home');
    return;
  }

  const t      = typeInfo(b.type);
  const statut = getStatut(b);
  const dateStr = new Date(b.createdAt).toLocaleDateString('fr-FR', {
    day: '2-digit', month: 'long', year: 'numeric'
  });

  // Galerie photos
  const galleryHtml = b.photos && b.photos.length
    ? `<div class="gallery">${b.photos.map((p, i) =>
        `<div class="gallery-item" onclick="openBienPhoto('${b.id}', ${i})">
           <img src="${escAttr(photoSrc(p))}" alt="Photo ${i+1}" loading="lazy"/>
         </div>`).join('')}</div>`
    : `<p style="color:var(--muted);font-size:14px">Aucune photo.</p>`;

  // Documents joints
  const docsHtml = b.docs && b.docs.length
    ? `<div class="detail-doc-list">${b.docs.map((d, i) =>
        `<div class="doc-item">
           <span class="doc-icon">${docIcon(d.name)}</span>
           <span class="doc-name"><a href="#" onclick="downloadDoc('${b.id}', ${i}); return false;" style="color:inherit;text-decoration:none">${esc(d.name)}</a></span>
           <span class="doc-size">${formatSize(d.size)}</span>
         </div>`).join('')}</div>`
    : `<p style="color:var(--muted);font-size:14px">Aucun fichier joint.</p>`;

  // Documents légaux
  const totalLegal   = LEGAL_DOCS_LIST.length;
  const legalDocs    = b.legalDocs || [];
  const presentCount = legalDocs.filter(d => d.present).length;
  const pct          = Math.round(presentCount / totalLegal * 100);

  const legalHtml = LEGAL_DOCS_LIST.map(def => {
    const d = legalDocs.find(x => x.id === def.id) || { present: false };
    const icon = d.present ? '✅' : '❌';
    const meta = [];
    if (d.reference) meta.push('Réf : ' + esc(d.reference));
    if (d.detenteur) meta.push('Détenteur : ' + esc(d.detenteur));
    return `<div class="detail-legal-item">
      <span class="detail-legal-icon">${icon}</span>
      <div class="detail-legal-text">
        <div class="detail-legal-label">${def.label}</div>
        ${meta.length ? `<div class="detail-legal-meta">${meta.join(' · ')}</div>` : ''}
      </div>
    </div>`;
  }).join('');

  const container = document.getElementById('detail-content');
  container.innerHTML = `
    <div class="detail-header">
      <div class="detail-header-left">
        <button class="btn btn-ghost" onclick="showView('home')" style="margin-bottom:12px">← Retour</button>
        <h1>${esc(b.nom)}</h1>
        <span class="badge ${t.badgeClass}" style="margin-right:6px">${t.emoji} ${t.label}</span>
        <span class="statut-badge ${statut.classe}">${statut.icone} ${statut.texte}</span>
      </div>
      <div class="detail-header-right">
        <button class="btn btn-pdf" id="btn-pdf-export" onclick="exportBienPDF('${b.id}')">📄 PDF</button>
        <button class="btn btn-ghost" onclick="showView('form','${b.id}')">✏️ Modifier</button>
        ${isAdmin() ? `<button class="btn btn-danger" onclick="deleteBien('${b.id}')">🗑️ Supprimer</button>` : ''}
      </div>
    </div>

    <div class="detail-grid">
      <div class="detail-card">
        <div class="detail-card-title">📋 Informations</div>
        <div class="detail-info-row"><span class="detail-info-label">Type</span><span class="detail-info-val">${t.emoji} ${t.label}</span></div>
        ${b.adresse ? `<div class="detail-info-row"><span class="detail-info-label">Adresse</span><span class="detail-info-val">📍 ${esc(b.adresse)}</span></div>` : ''}
        ${b.lat != null ? `<div class="detail-info-row"><span class="detail-info-label">GPS</span><span class="detail-info-val">${b.lat.toFixed(5)}, ${b.lng.toFixed(5)}</span></div>` : ''}
        <div class="detail-info-row"><span class="detail-info-label">Ajouté le</span><span class="detail-info-val">${dateStr}</span></div>
        ${b.createdBy ? `<div class="detail-info-row"><span class="detail-info-label">Ajouté par</span><span class="detail-info-val">${esc(membreLabel(b.createdBy))}</span></div>` : ''}
        ${b.description ? `<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);font-size:14px;line-height:1.7;color:var(--text2)">${esc(b.description)}</div>` : ''}
      </div>
      <div class="detail-card">
        <div class="detail-card-title">📍 Localisation</div>
        ${b.lat != null ? `<div id="map-detail"></div>` : `<p style="color:var(--muted);font-size:14px">Position non renseignée.</p>`}
      </div>
    </div>

    <div class="detail-card" style="margin-top:16px">
      <div class="detail-card-title">📋 Documents légaux
        <span style="font-size:12px;font-weight:400;color:var(--muted);margin-left:8px">${presentCount}/${totalLegal} présents · ${pct}%</span>
      </div>
      <div style="background:var(--border);border-radius:20px;height:6px;overflow:hidden;margin-bottom:14px">
        <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,var(--accent),var(--success));border-radius:20px;transition:width .4s"></div>
      </div>
      ${legalHtml}
    </div>

    <div class="detail-card" style="margin-top:16px">
      <div class="detail-card-title">📸 Photos (${b.photos ? b.photos.length : 0})</div>
      ${galleryHtml}
    </div>

    <div class="detail-card" style="margin-top:16px">
      <div class="detail-card-title">📎 Fichiers joints (${b.docs ? b.docs.length : 0})</div>
      ${docsHtml}
    </div>
  `;

  // Carte du détail
  if (b.lat != null) {
    setTimeout(() => {
      // Important : détruire la carte précédente sinon Leaflet plante
      if (mapDetail) { mapDetail.remove(); mapDetail = null; }
      mapDetail = L.map('map-detail').setView([b.lat, b.lng], 14);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap', maxZoom: 19
      }).addTo(mapDetail);
      L.marker([b.lat, b.lng], { icon: makeMarkerIcon(b.type) }).addTo(mapDetail)
        .bindPopup(`<strong>${esc(b.nom)}</strong>`).openPopup();
      setTimeout(() => mapDetail.invalidateSize(), 100);
    }, 150);
  }
}

/* ============================================================
   🗑️ SUPPRESSION
============================================================ */
async function deleteBien(id) {
  if (!isAdmin()) return showToast('⚠️ Seul l\'administrateur peut supprimer un bien.', 'error');
  const b = getBiens().find(x => x.id === id);
  if (!b) return showToast('⚠️ Bien introuvable.', 'error');
  if (!confirm('Supprimer ce bien définitivement ? Cette action est irréversible.')) return;

  showLoader();
  const { data, error } = await sb.from('biens').delete().eq('id', id).select('id');
  hideLoader();
  if (error || !data || !data.length) {
    return showToast('⚠️ Suppression impossible : ' + (error ? error.message : 'accès refusé'), 'error');
  }
  await removeStoragePaths([...b.photos, ...b.docs].map(f => f.path));
  showToast('🗑️ Bien supprimé.', 'success');
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
  if (!d.path) return showToast('⚠️ Fichier indisponible.', 'error');
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(d.path, 60, { download: d.name });
  if (error) return showToast('⚠️ Téléchargement impossible : ' + error.message, 'error');
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
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLightbox(); });

/* ============================================================
   🔔 TOASTS
============================================================ */
function showToast(msg, type = '') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.transition = 'opacity .3s ease';
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

/* ============================================================
   🛠️ UTILITAIRES
============================================================ */
function docIcon(name) {
  const ext = String(name).split('.').pop().toLowerCase();
  if (ext === 'pdf') return '📄';
  if (['jpg','jpeg','png','webp','gif'].includes(ext)) return '🖼️';
  if (['doc','docx'].includes(ext)) return '📝';
  return '📎';
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
  if (!biens.length) return showToast('⚠️ Aucun bien à exporter.', 'error');

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
    showToast(`✅ ${biens.length} bien(s) exporté(s) !`, 'success');
  } catch (e) {
    showToast('⚠️ Erreur d\'export : ' + e.message, 'error');
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
      return showToast('⚠️ Erreur de lecture : ' + err.message, 'error');
    }
    if (!data.biens || !Array.isArray(data.biens)) {
      return showToast('⚠️ Fichier invalide.', 'error');
    }

    showLoader();
    const n = await importBiensList(data.biens);
    hideLoader();
    showToast(`✅ ${n} bien(s) importé(s) sur ${data.biens.length}.`, n ? 'success' : '');
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
  showToast(`✅ ${n} bien(s) transféré(s) dans l'espace familial.`, 'success');
  showView('home');
}

/* ============================================================
   📄 EXPORT PDF (jsPDF)
============================================================ */
async function exportBienPDF(id) {
  const b = getBiens().find(x => x.id === id);
  if (!b) return showToast('⚠️ Bien introuvable.', 'error');

  if (typeof window.jspdf === 'undefined') {
    return showToast('⚠️ jsPDF non chargé. Vérifiez votre connexion internet.', 'error');
  }

  const btn = document.getElementById('btn-pdf-export');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Génération…'; }

  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

    const PAGE_W  = 210;
    const MARGIN  = 18;
    const CONTENT = PAGE_W - MARGIN * 2;
    let y = MARGIN;
    const ACCENT = [201, 169, 110];

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
    showToast('✅ PDF exporté !', 'success');

  } catch(err) {
    console.error('Erreur PDF:', err);
    showToast('⚠️ Erreur PDF : ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📄 PDF'; }
  }
}

/* ============================================================
   🔐 CONNEXION & DEMANDE D'ACCÈS
   - Un proche envoie nom / prénom / e-mail  → demande "en_attente"
   - L'admin valide depuis le panneau 👑      → "approuve"
   - Le membre se connecte avec un lien reçu par e-mail (sans mot de passe)
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

function setAuthTab(tab) {
  ['login', 'demande'].forEach(t => {
    document.getElementById('tab-'  + t).classList.toggle('active', t === tab);
    document.getElementById('pane-' + t).classList.toggle('active', t === tab);
  });
  setAuthMessage('');
}

function setAuthMessage(html, type = '') {
  const el = document.getElementById('auth-message');
  if (!el) return;
  el.className = 'auth-message' + (html ? ' visible ' + type : '');
  el.innerHTML = html;
}

function setBusy(btnId, busy, label) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  if (busy) { btn.dataset.label = btn.textContent; btn.textContent = label; }
  else if (btn.dataset.label) btn.textContent = btn.dataset.label;
  btn.disabled = busy;
}

function authErrorMessage(error) {
  if (!error) return '';
  if (error.status === 429 || /rate limit|security purposes/i.test(error.message || '')) {
    return 'Trop de tentatives. Patientez quelques minutes avant de réessayer.';
  }
  return error.message || 'Erreur inconnue.';
}

function goToLogin(email) {
  setAuthTab('login');
  document.getElementById('login-email').value = email || '';
}

async function sendLoginLink() {
  const email = document.getElementById('login-email').value.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return setAuthMessage('⚠️ Adresse e-mail invalide.', 'error');

  setBusy('btn-login', true, '⏳ Vérification…');
  try {
    const { data: statut, error } = await sb.rpc('statut_email', { p_email: email });
    if (error) throw error;

    if (statut === 'inconnu') {
      return setAuthMessage(
        'Aucune demande pour cette adresse. ' +
        '<button type="button" class="link-btn" onclick="setAuthTab(\'demande\')">Faire une demande d\'accès</button>', 'error');
    }
    if (statut === 'en_attente') {
      return setAuthMessage('⏳ Votre demande est <strong>en attente</strong> : l\'administrateur doit encore la valider.');
    }
    if (statut === 'refuse') {
      return setAuthMessage('🚫 Votre demande a été refusée. Contactez l\'administrateur de la famille.', 'error');
    }

    const { error: otpErr } = await sb.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: appUrl(), shouldCreateUser: true }
    });
    if (otpErr) throw otpErr;
    setAuthMessage(
      `📬 Lien envoyé à <strong>${esc(email)}</strong>.<br>` +
      'Ouvrez l\'e-mail <strong>sur cet appareil</strong> et cliquez sur le lien pour vous connecter. ' +
      'Pensez à regarder dans les spams.', 'success');
  } catch (e) {
    setAuthMessage('⚠️ ' + esc(authErrorMessage(e)), 'error');
  } finally {
    setBusy('btn-login', false);
  }
}

async function sendDemande() {
  const prenom = sanitizeInput(document.getElementById('dem-prenom').value).slice(0, 80);
  const nom    = sanitizeInput(document.getElementById('dem-nom').value).slice(0, 80);
  const email  = document.getElementById('dem-email').value.trim().toLowerCase();

  if (!prenom || !nom)       return setAuthMessage('⚠️ Nom et prénom obligatoires.', 'error');
  if (!EMAIL_RE.test(email)) return setAuthMessage('⚠️ Adresse e-mail invalide.', 'error');

  setBusy('btn-demande', true, '⏳ Envoi…');
  try {
    const { data: res, error } = await sb.rpc('demander_acces', { p_nom: nom, p_prenom: prenom, p_email: email });
    if (error) throw error;

    const loginBtn = `<button type="button" class="link-btn" onclick="goToLogin('${escAttr(email)}')">Se connecter</button>`;
    const messages = {
      envoyee:          [`✅ Merci ${esc(prenom)}, votre demande est envoyée !<br>Dès que l'administrateur l'aura acceptée, revenez ici et cliquez sur « Se connecter » avec <strong>${esc(email)}</strong>.`, 'success'],
      en_attente:       ['⏳ Une demande existe déjà pour cette adresse. Elle attend la validation de l\'administrateur.', ''],
      approuve:         [`✅ Cette adresse est déjà acceptée. ${loginBtn}`, 'success'],
      refuse:           ['🚫 Une demande pour cette adresse a été refusée. Contactez l\'administrateur de la famille.', 'error'],
      complet:          [`👨‍👩‍👧 La famille est complète (${MAX_MEMBRES} membres maximum). Contactez l'administrateur.`, 'error'],
      trop_de_demandes: ['⚠️ Trop de demandes sont en attente. Réessayez plus tard.', 'error']
    };
    const [html, type] = messages[res] || ['⚠️ Réponse inattendue du serveur.', 'error'];
    setAuthMessage(html, type);
    if (res === 'envoyee') {
      ['dem-prenom', 'dem-nom', 'dem-email'].forEach(id => { document.getElementById(id).value = ''; });
    }
  } catch (e) {
    setAuthMessage('⚠️ ' + esc(authErrorMessage(e)), 'error');
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
  currentMember = null;
  biensCache    = [];
  membresCache  = [];
  document.body.classList.remove('is-admin');
}

/* Écran générique (attente de validation, configuration manquante…) */
function showMessage(icon, title, html, actions) {
  document.getElementById('message-icon').textContent  = icon;
  document.getElementById('message-title').textContent = title;
  document.getElementById('message-text').innerHTML    = html;
  document.getElementById('message-actions').innerHTML = actions || '';
  showView('message');
}

/** Après connexion : vérifie que l'utilisateur est un membre validé. */
async function checkMembership() {
  const email = (session && session.user && session.user.email || '').toLowerCase();
  if (!email) return showView('auth');

  const { data, error } = await sb.from('membres').select('*').eq('email', email).maybeSingle();
  if (error) {
    return showMessage('⚠️', 'Connexion impossible', esc(error.message),
      `<button class="btn btn-primary" onclick="checkMembership()">🔄 Réessayer</button>
       <button class="btn btn-ghost" onclick="logout()">Se déconnecter</button>`);
  }
  currentMember = data;

  if (isApproved()) return enterApp();

  const actions = `<button class="btn btn-primary" onclick="checkMembership()">🔄 Vérifier à nouveau</button>
                   <button class="btn btn-ghost" onclick="logout()">Se déconnecter</button>`;
  if (!data) {
    showMessage('🤔', 'Aucune demande trouvée',
      `Aucune demande d'accès n'existe pour <strong>${esc(email)}</strong>.<br>Déconnectez-vous puis utilisez « Demander l'accès ».`, actions);
  } else if (data.statut === 'refuse') {
    showMessage('🚫', 'Demande refusée',
      'Votre demande d\'accès a été refusée. Contactez l\'administrateur de la famille.', actions);
  } else {
    showMessage('⏳', 'Demande en attente',
      `Bonjour ${esc(data.prenom)} ! Votre demande est bien reçue.<br>L'administrateur doit la valider avant que vous puissiez accéder aux biens.`, actions);
  }
}

function enterApp() {
  document.body.classList.toggle('is-admin', isAdmin());
  document.getElementById('user-chip').textContent = `👤 ${currentMember.prenom}`;
  showView('home');
  if (isAdmin()) setTimeout(proposeMigration, 800);
}

/* ============================================================
   👑 ADMINISTRATION DES MEMBRES
============================================================ */
async function loadMembres() {
  if (!isAdmin()) return;
  const { data, error } = await sb.from('membres').select('*').order('created_at');
  if (error) return showToast('⚠️ Impossible de charger les membres : ' + error.message, 'error');
  membresCache = data;
  updateAdminBadge();
}

function updateAdminBadge() {
  const n = membresCache.filter(m => m.statut === 'en_attente').length;
  const badge = document.getElementById('admin-badge');
  if (!badge) return;
  badge.textContent = n;
  badge.classList.toggle('visible', n > 0);
}

function membreItem(m, actions) {
  const initiales = (String(m.prenom || '?').charAt(0) + String(m.nom || '').charAt(0)).toUpperCase();
  const date = new Date(m.created_at).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
  return `<div class="membre-item">
    <div class="membre-avatar">${esc(initiales)}</div>
    <div class="membre-info">
      <div class="membre-nom">${esc(m.prenom)} ${esc(m.nom)}${m.role === 'admin' ? '<span class="role-badge">👑 Admin</span>' : ''}</div>
      <div class="membre-meta">${esc(m.email)} · demande du ${date}</div>
    </div>
    ${actions ? `<div class="membre-actions">${actions}</div>` : ''}
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
  document.getElementById('quota-text').textContent =
    `${membres.length} membre${membres.length > 1 ? 's' : ''} sur ${MAX_MEMBRES}` +
    (complet ? ' · famille complète' : ` · ${MAX_MEMBRES - membres.length} place(s) libre(s)`);
  document.getElementById('quota-pct').textContent = pct + '%';
  document.getElementById('share-link').value = appUrl();
  document.getElementById('admin-pending-count').textContent = pending.length;

  document.getElementById('admin-pending').innerHTML = pending.length
    ? pending.map(m => membreItem(m,
        `<button class="btn btn-success" ${complet ? 'disabled title="Famille complète : retirez d\'abord un membre"' : ''} onclick="decideMembre('${m.id}', 'approuve')">✅ Accepter</button>
         <button class="btn btn-ghost" onclick="decideMembre('${m.id}', 'refuse')">❌ Refuser</button>`)).join('')
    : '<p class="membre-empty">Aucune demande en attente.</p>';

  document.getElementById('admin-membres').innerHTML = membres.length
    ? membres.map(m => membreItem(m, m.role === 'admin' ? '' :
        `<button class="btn btn-ghost" title="Envoyer un e-mail de bienvenue" onclick="notifyMembre('${m.id}')">✉️ Prévenir</button>
         <button class="btn btn-ghost" onclick="removeMembre('${m.id}')">Retirer</button>`)).join('')
    : '<p class="membre-empty">Aucun membre.</p>';

  document.getElementById('admin-refuses-card').style.display = refuses.length ? '' : 'none';
  document.getElementById('admin-refuses').innerHTML = refuses.map(m => membreItem(m,
    `<button class="btn btn-ghost" ${complet ? 'disabled' : ''} onclick="decideMembre('${m.id}', 'approuve')">✅ Accepter</button>
     <button class="btn btn-ghost" onclick="removeMembre('${m.id}')">🗑️ Effacer</button>`)).join('');

  updateAdminBadge();
}

async function decideMembre(id, statut) {
  const m = membresCache.find(x => x.id === id);
  if (!m) return;
  if (statut === 'refuse' && !confirm(`Refuser la demande de ${m.prenom} ${m.nom} ?`)) return;

  const { data, error } = await sb.from('membres').update({ statut }).eq('id', id).select();
  if (error || !data || !data.length) {
    return showToast('⚠️ ' + (error ? error.message : 'Action refusée.'), 'error');
  }
  await loadMembres();
  renderAdmin();

  if (statut === 'approuve') {
    showToast(`✅ ${m.prenom} fait maintenant partie de la famille !`, 'success');
    if (confirm(`Envoyer un e-mail à ${m.prenom} pour le/la prévenir ?`)) notifyMembre(id);
  } else {
    showToast(`Demande de ${m.prenom} refusée.`, 'success');
  }
}

async function removeMembre(id) {
  const m = membresCache.find(x => x.id === id);
  if (!m || m.role === 'admin') return;
  const msg = m.statut === 'approuve'
    ? `Retirer ${m.prenom} ${m.nom} de la famille ? Il/elle n'aura plus accès aux biens.`
    : `Effacer la demande de ${m.prenom} ${m.nom} ? La personne pourra refaire une demande.`;
  if (!confirm(msg)) return;

  const { data, error } = await sb.from('membres').delete().eq('id', id).select('id');
  if (error || !data || !data.length) {
    return showToast('⚠️ ' + (error ? error.message : 'Action refusée.'), 'error');
  }
  showToast(`${m.prenom} a été retiré(e).`, 'success');
  await loadMembres();
  renderAdmin();
}

function notifyMembre(id) {
  const m = membresCache.find(x => x.id === id);
  if (!m) return;
  const subject = 'Ton accès à ImmoFamille est validé';
  const body =
    `Bonjour ${m.prenom},\n\n` +
    `Ta demande d'accès à ImmoFamille est acceptée !\n\n` +
    `Pour te connecter, ouvre ce lien, clique sur « Se connecter » et saisis ton adresse (${m.email}) :\n` +
    `${appUrl()}\n\n` +
    `Tu recevras un lien de connexion par e-mail, pas besoin de mot de passe.\n\n` +
    `À bientôt,\n${currentMember.prenom}`;
  window.location.href = `mailto:${encodeURIComponent(m.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function copyShareLink() {
  const url = appUrl();
  const done = () => showToast('📋 Lien copié !', 'success');
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
    return showMessage('📡', 'Connexion impossible',
      'La bibliothèque Supabase n\'a pas pu être chargée. Vérifiez votre connexion internet puis rechargez la page.',
      '<button class="btn btn-primary" onclick="location.reload()">🔄 Recharger</button>');
  }
  if (!configOk()) {
    return showMessage('⚙️', 'Configuration requise',
      'Renseignez l\'adresse et la clé de votre projet Supabase dans le fichier <code>config.js</code>, ' +
      'puis exécutez <code>supabase/schema.sql</code>. Tout est expliqué dans le <code>README.md</code>.');
  }

  sb = window.supabase.createClient(window.IMMO_CONFIG.SUPABASE_URL, window.IMMO_CONFIG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' }
  });

  // Lien de connexion expiré ou déjà utilisé
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const linkError = hash.get('error_description');

  const { data } = await sb.auth.getSession();
  session = data.session;

  // Changement de session (déconnexion dans un autre onglet, nouvel utilisateur…)
  sb.auth.onAuthStateChange((event, newSession) => {
    const prevEmail = session && session.user ? session.user.email : null;
    session = newSession;
    if (event === 'SIGNED_OUT') {
      resetSessionState();
      showView('auth');
    } else if (event === 'SIGNED_IN' && newSession && newSession.user.email !== prevEmail) {
      // Ne pas appeler Supabase directement dans ce callback
      setTimeout(checkMembership, 0);
    }
  });

  if (window.location.hash) history.replaceState(null, '', appUrl() + window.location.search);

  if (session) {
    await checkMembership();
  } else {
    showView('auth');
    if (linkError) {
      setAuthMessage('⚠️ Ce lien de connexion n\'est plus valide (expiré ou déjà utilisé). Demandez-en un nouveau.', 'error');
    }
  }
}

window.addEventListener('load', () => {
  initTheme();
  initApp();
});
