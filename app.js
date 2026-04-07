/* ============================================================
   ImmoFamille — app.js
   Application de gestion de biens immobiliers
   Version propre et corrigée — usage personnel/famille
============================================================ */

'use strict';

/* ============================================================
   CONSTANTES
============================================================ */
const MAX_PHOTOS   = 5;
const MAX_DOCS     = 5;
const MAX_IMG_SIZE = 5  * 1024 * 1024;   // 5 Mo
const MAX_DOC_SIZE = 10 * 1024 * 1024;   // 10 Mo

const STORAGE_KEY  = 'immofamille_biens';
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
   💾 STOCKAGE — localStorage avec try/catch
============================================================ */
function getBiens() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error('Erreur lecture localStorage :', e);
    showToast('⚠️ Impossible de lire les données sauvegardées.', 'error');
    return [];
  }
}

function saveBiens(biens) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(biens));
    return true;
  } catch (e) {
    console.error('Erreur écriture localStorage :', e);
    if (e.name === 'QuotaExceededError' || e.code === 22) {
      showToast('⚠️ Stockage plein ! Supprimez des biens ou réduisez le nombre de photos.', 'error');
    } else {
      showToast('⚠️ Erreur de sauvegarde : ' + e.message, 'error');
    }
    return false;
  }
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
function showView(name, bienId) {
  showLoader();
  setTimeout(() => {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const target = document.getElementById('view-' + name);
    if (target) target.classList.add('active');
    hideLoader();

    // Afficher le FAB seulement sur la page d'accueil
    const fab = document.getElementById('fab-add');
    if (fab) fab.style.display = (name === 'home') ? '' : 'none';

    if (name === 'home') {
      initMap();
      renderList();
    } else if (name === 'form') {
      resetForm(bienId);
      initMapPicker();
    } else if (name === 'detail' && bienId) {
      renderDetail(bienId);
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
      ? `<img class="bien-card-img" src="${b.photos[0].dataUrl}" alt="${esc(b.nom)}" loading="lazy"/>`
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

    const reader = new FileReader();
    reader.onload = e => {
      formPhotos.push({ name: sanitizeFileName(file.name), dataUrl: e.target.result });
      renderPhotoPreviews();
    };
    reader.onerror = () => showToast('⚠️ Erreur de lecture du fichier.', 'error');
    reader.readAsDataURL(file);
  });
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
      <img src="${p.dataUrl}" alt="${esc(p.name)}"/>
      <button type="button" class="remove-btn" onclick="removePhoto(${i})">✕</button>
    </div>`
  ).join('');

  const rem = MAX_PHOTOS - formPhotos.length;
  document.getElementById('photo-counter').textContent = formPhotos.length === 0
    ? `${MAX_PHOTOS} photos maximum`
    : `${formPhotos.length}/${MAX_PHOTOS} · encore ${rem} possible(s)`;
}

function removePhoto(i) {
  formPhotos.splice(i, 1);
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

    const reader = new FileReader();
    reader.onload = e => {
      formDocs.push({
        name:    sanitizeFileName(file.name),
        size:    file.size,
        dataUrl: e.target.result
      });
      renderDocPreviews();
    };
    reader.onerror = () => showToast('⚠️ Erreur de lecture du fichier.', 'error');
    reader.readAsDataURL(file);
  });
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
function saveBien() {
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

  const biens = getBiens();
  let success;

  if (editingId) {
    // MODIFICATION
    const idx = biens.findIndex(b => b.id === editingId);
    if (idx === -1) return showToast('⚠️ Bien introuvable.', 'error');

    biens[idx] = {
      ...biens[idx],
      nom:         sanitizeInput(nom),
      type,
      description: sanitizeInput(desc),
      adresse:     sanitizeInput(document.getElementById('f-adresse').value.trim()),
      lat:         latF,
      lng:         lngF,
      photos:      [...formPhotos],
      docs:        [...formDocs],
      legalDocs:   collectLegalDocs(),
      updatedAt:   new Date().toISOString()
    };
    success = saveBiens(biens);
    if (success) showToast('✅ Bien modifié !', 'success');
  } else {
    // AJOUT
    biens.push({
      id:          Date.now().toString(),
      nom:         sanitizeInput(nom),
      type,
      description: sanitizeInput(desc),
      adresse:     sanitizeInput(document.getElementById('f-adresse').value.trim()),
      lat:         latF,
      lng:         lngF,
      photos:      [...formPhotos],
      docs:        [...formDocs],
      legalDocs:   collectLegalDocs(),
      createdAt:   new Date().toISOString()
    });
    success = saveBiens(biens);
    if (success) showToast('✅ Bien enregistré !', 'success');
  }

  if (success) {
    // Réinitialiser l'état d'édition AVANT navigation
    editingId = null;
    formPhotos = [];
    formDocs = [];
    showView('home');
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
        `<div class="gallery-item" onclick="openLightbox('${p.dataUrl}')">
           <img src="${p.dataUrl}" alt="Photo ${i+1}" loading="lazy"/>
         </div>`).join('')}</div>`
    : `<p style="color:var(--muted);font-size:14px">Aucune photo.</p>`;

  // Documents joints
  const docsHtml = b.docs && b.docs.length
    ? `<div class="detail-doc-list">${b.docs.map(d =>
        `<div class="doc-item">
           <span class="doc-icon">${docIcon(d.name)}</span>
           <span class="doc-name"><a href="${d.dataUrl}" download="${escAttr(d.name)}" style="color:inherit;text-decoration:none">${esc(d.name)}</a></span>
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
        <button class="btn btn-danger" onclick="deleteBien('${b.id}')">🗑️ Supprimer</button>
      </div>
    </div>

    <div class="detail-grid">
      <div class="detail-card">
        <div class="detail-card-title">📋 Informations</div>
        <div class="detail-info-row"><span class="detail-info-label">Type</span><span class="detail-info-val">${t.emoji} ${t.label}</span></div>
        ${b.adresse ? `<div class="detail-info-row"><span class="detail-info-label">Adresse</span><span class="detail-info-val">📍 ${esc(b.adresse)}</span></div>` : ''}
        ${b.lat != null ? `<div class="detail-info-row"><span class="detail-info-label">GPS</span><span class="detail-info-val">${b.lat.toFixed(5)}, ${b.lng.toFixed(5)}</span></div>` : ''}
        <div class="detail-info-row"><span class="detail-info-label">Ajouté le</span><span class="detail-info-val">${dateStr}</span></div>
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
function deleteBien(id) {
  if (!confirm('Supprimer ce bien définitivement ? Cette action est irréversible.')) return;
  const biens = getBiens().filter(b => b.id !== id);
  if (saveBiens(biens)) {
    showToast('🗑️ Bien supprimé.', 'success');
    showView('home');
  }
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
   📤 EXPORT JSON
============================================================ */
function exportJSON() {
  const biens = getBiens();
  if (!biens.length) return showToast('⚠️ Aucun bien à exporter.', 'error');

  try {
    const dataStr = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), biens }, null, 2);
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
  }
}

/* ============================================================
   📥 IMPORT JSON
============================================================ */
function importJSON(input) {
  const file = input.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      if (!data.biens || !Array.isArray(data.biens)) {
        return showToast('⚠️ Fichier invalide.', 'error');
      }

      const existing    = getBiens();
      const existingIds = new Set(existing.map(b => b.id));

      const toImport = data.biens.filter(b => {
        if (!b.id || typeof b.id !== 'string') return false;
        if (!b.nom || typeof b.nom !== 'string' || b.nom.trim() === '') return false;
        if (!Object.keys(TYPE_CONFIG).includes(b.type)) return false;
        if (existingIds.has(b.id)) return false;
        b.nom         = sanitizeInput(String(b.nom).slice(0, 200));
        b.description = sanitizeInput(String(b.description || '').slice(0, 2000));
        b.adresse     = sanitizeInput(String(b.adresse || '').slice(0, 500));
        if (b.lat != null) {
          b.lat = parseFloat(b.lat);
          if (isNaN(b.lat) || b.lat < -90 || b.lat > 90) return false;
        }
        if (b.lng != null) {
          b.lng = parseFloat(b.lng);
          if (isNaN(b.lng) || b.lng < -180 || b.lng > 180) return false;
        }
        return true;
      });

      if (saveBiens([...existing, ...toImport])) {
        showToast(`✅ ${toImport.length} bien(s) importé(s) sur ${data.biens.length}.`, 'success');
        if (document.getElementById('view-home').classList.contains('active')) {
          refreshMapMarkers();
          renderList();
        }
      }
    } catch (err) {
      showToast('⚠️ Erreur de lecture : ' + err.message, 'error');
    }
  };
  reader.readAsText(file);
  input.value = '';
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
        const fmt = photo.dataUrl.startsWith('data:image/png') ? 'PNG'
                  : photo.dataUrl.startsWith('data:image/webp') ? 'WEBP' : 'JPEG';
        const x = MARGIN + col * (IMG_W + 8);

        checkNewPage(IMG_H + 8);
        if (col === 0) rowY = y;

        try {
          doc.addImage(photo.dataUrl, fmt, x, rowY, IMG_W, IMG_H, '', 'MEDIUM');
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
   🚀 INITIALISATION
============================================================ */
window.addEventListener('load', () => {
  initTheme();
  showView('home');
});
