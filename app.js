// ── Projection setup ──────────────────────────────────────────────────────────
proj4.defs('EPSG:25832', '+proj=utm +zone=32 +ellps=GRS80 +datum=ETRS89 +units=m +no_defs');

function toWGS84(coord) {
  return proj4('EPSG:25832', 'WGS84', coord);
}

function reprojectGeometry(geom) {
  if (!geom || !geom.coordinates) return geom;
  const reproject = rings => rings.map(ring =>
    Array.isArray(ring[0]) ? ring.map(pt => toWGS84(pt)) : toWGS84(ring)
  );
  if (geom.type === 'Polygon')      return { ...geom, coordinates: reproject(geom.coordinates) };
  if (geom.type === 'MultiPolygon') return { ...geom, coordinates: geom.coordinates.map(reproject) };
  if (geom.type === 'Point')        return { ...geom, coordinates: toWGS84(geom.coordinates) };
  return geom;
}

// ── Extent helpers ────────────────────────────────────────────────────────────
function lngLatBoundsToEPSG25833(bounds) {
  const sw = proj4('WGS84', 'EPSG:25832', [bounds.getWest(), bounds.getSouth()]);
  const ne = proj4('WGS84', 'EPSG:25832', [bounds.getEast(), bounds.getNorth()]);
  return `${sw[0]},${sw[1]},${ne[0]},${ne[1]}`;
}

// ── Status helpers ────────────────────────────────────────────────────────────
const STATUS_MAP = {
  'innvilget':   { label: 'Approved – work ongoing', cls: 'active' },
  'koordinert':  { label: 'Coordinated – planned',   cls: 'planned' },
  'søkt':        { label: 'Applied – pending',        cls: 'planned' },
  'avsluttet':   { label: 'Completed',                cls: 'done' },
  'avvist':      { label: 'Rejected',                 cls: 'done' },
  'under arbeid':{ label: 'Work in progress',         cls: 'active' },
};

function resolveStatus(raw) {
  if (!raw) return { label: 'Unknown', cls: 'unknown' };
  const key = raw.toLowerCase().trim();
  return STATUS_MAP[key] || { label: raw, cls: 'unknown' };
}

function statusToColor(cls) {
  return { active: '#f59e0b', planned: '#3b82f6', done: '#9ca3af', unknown: '#a78bfa' }[cls] || '#9ca3af';
}

function featureCategory(props) {
  const now = Date.now();
  const start = props.start_date ? new Date(props.start_date).getTime() : null;
  const end   = props.end_date   ? new Date(props.end_date).getTime()   : null;
  const st = resolveStatus(props.status);
  if (st.cls === 'done') return 'done';
  if (start && start > now) return 'planned';
  if (end && end < now) return 'done';
  return 'active';
}

// ── Date formatting ───────────────────────────────────────────────────────────
function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ── Map init ──────────────────────────────────────────────────────────────────
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/positron',
  center: [10.757, 59.913],
  zoom: 12,
});

map.addControl(new maplibregl.NavigationControl(), 'bottom-right');

// ── State ─────────────────────────────────────────────────────────────────────
let allFeatures = [];
let dateFrom = null;
let dateTo   = null;

// ── Default date range: today → +30 days ─────────────────────────────────────
(function initDates() {
  const today = new Date();
  const plus30 = new Date(today);
  plus30.setDate(plus30.getDate() + 30);
  const fmt = d => d.toISOString().slice(0, 10);
  document.getElementById('date-from').value = fmt(today);
  document.getElementById('date-to').value   = fmt(plus30);
  dateFrom = today;
  dateTo   = plus30;
})();

// ── Fetch data ────────────────────────────────────────────────────────────────
async function fetchLayer(endpoint, filterParam) {
  const extent = lngLatBoundsToEPSG25833(map.getBounds());
  const url = `/api/map/${endpoint}?extent=${extent}&filter=${filterParam}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return [];
    let data = await resp.json();
    if (typeof data === 'string') data = JSON.parse(data);
    return (data.features || []).map(f => ({
      ...f,
      geometry: reprojectGeometry(f.geometry),
    }));
  } catch (e) {
    console.warn('Fetch error', endpoint, e);
    return [];
  }
}

async function loadData() {
  const [plans, activities] = await Promise.all([
    fetchLayer('soksys-plans',      'ptimequick=4'),
    fetchLayer('soksys-activities', 'atimequick=4'),
  ]);

  // Tag source type
  plans.forEach(f => { f.properties._source = 'plan'; });
  activities.forEach(f => { f.properties._source = 'activity'; });

  // Deduplicate by id
  const seen = new Set();
  allFeatures = [...plans, ...activities].filter(f => {
    const id = f.properties.id || f.properties.plan_id || f.properties.activity_id;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  applyFilters();
}

// ── Filter & render ───────────────────────────────────────────────────────────
function applyFilters() {
  const from = dateFrom ? dateFrom.getTime() : null;
  const to   = dateTo   ? dateTo.getTime()   : null;

  const visible = allFeatures.filter(f => {
    const p = f.properties;
    const start = p.start_date ? new Date(p.start_date).getTime() : null;
    const end   = p.end_date   ? new Date(p.end_date).getTime()   : null;
    // Feature overlaps the selected window
    if (from && end   && end   < from) return false;
    if (to   && start && start > to)   return false;
    return true;
  });

  // Attach category color
  visible.forEach(f => {
    f.properties._category = featureCategory(f.properties);
    f.properties._color    = statusToColor(f.properties._category);
  });

  const geojson = { type: 'FeatureCollection', features: visible };

  if (map.getSource('roadworks')) {
    map.getSource('roadworks').setData(geojson);
  } else {
    map.addSource('roadworks', { type: 'geojson', data: geojson, generateId: true });

    map.addLayer({
      id: 'roadworks-fill',
      type: 'fill',
      source: 'roadworks',
      paint: {
        'fill-color': ['get', '_color'],
        'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.75, 0.45],
      },
    });

    map.addLayer({
      id: 'roadworks-outline',
      type: 'line',
      source: 'roadworks',
      paint: {
        'line-color': ['get', '_color'],
        'line-width': ['case', ['boolean', ['feature-state', 'hover'], false], 2.5, 1.2],
      },
    });
  }

  updateBadge(visible.length);
}

function updateBadge(n) {
  document.getElementById('count-badge').textContent =
    n === 0 ? 'No works in view' : `${n} work${n === 1 ? '' : 's'} in view`;
}

// ── Hover effect ──────────────────────────────────────────────────────────────
let hoveredId = null;

map.on('mousemove', 'roadworks-fill', e => {
  map.getCanvas().style.cursor = 'pointer';
  if (hoveredId !== null) map.setFeatureState({ source: 'roadworks', id: hoveredId }, { hover: false });
  hoveredId = e.features[0].id;
  map.setFeatureState({ source: 'roadworks', id: hoveredId }, { hover: true });
});

map.on('mouseleave', 'roadworks-fill', () => {
  map.getCanvas().style.cursor = '';
  if (hoveredId !== null) map.setFeatureState({ source: 'roadworks', id: hoveredId }, { hover: false });
  hoveredId = null;
});

// ── Click → sidebar ───────────────────────────────────────────────────────────
map.on('click', 'roadworks-fill', e => {
  const props = e.features[0].properties;
  showSidebar(props);
});

function showSidebar(props) {
  const status = resolveStatus(props.status);
  const cat    = featureCategory(props);
  const addresses = (() => {
    try { return JSON.parse(props.addresses || '[]').join(', ') || '—'; }
    catch { return props.addresses || '—'; }
  })();

  const who  = props.sender || props.initiator || props.OwnerName || '—';
  const type = props.activity_type || props.objectType || '—';
  const district = props.city_district
    ? props.city_district.charAt(0) + props.city_district.slice(1).toLowerCase()
    : '—';

  document.getElementById('sidebar-content').innerHTML = `
    <h2>${props.title || 'Roadwork'}</h2>
    <div class="detail-row">
      <span class="detail-label">Status</span>
      <span><span class="status-pill ${cat}">${status.label}</span></span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Dates</span>
      <span class="detail-value">${fmtDate(props.start_date)} – ${fmtDate(props.end_date)}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Address</span>
      <span class="detail-value">${addresses}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">City district</span>
      <span class="detail-value">${district}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Performed by</span>
      <span class="detail-value">${who}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Type</span>
      <span class="detail-value">${type}</span>
    </div>
    ${props.case_handler ? `
    <div class="detail-row">
      <span class="detail-label">Case handler</span>
      <span class="detail-value">${props.case_handler}</span>
    </div>` : ''}
    ${props.file_number || props.planNumber ? `
    <div class="detail-row">
      <span class="detail-label">Reference</span>
      <span class="detail-value">${props.file_number || props.planNumber}</span>
    </div>` : ''}
  `;

  document.getElementById('sidebar').classList.remove('hidden');
}

document.getElementById('sidebar-close').addEventListener('click', () => {
  document.getElementById('sidebar').classList.add('hidden');
});

// Close sidebar on map click outside a feature
map.on('click', e => {
  const features = map.queryRenderedFeatures(e.point, { layers: ['roadworks-fill'] });
  if (!features.length) document.getElementById('sidebar').classList.add('hidden');
});

// ── Date filter controls ──────────────────────────────────────────────────────
document.getElementById('date-from').addEventListener('change', e => {
  dateFrom = e.target.value ? new Date(e.target.value) : null;
  applyFilters();
});

document.getElementById('date-to').addEventListener('change', e => {
  dateTo = e.target.value ? new Date(e.target.value) : null;
  applyFilters();
});

document.getElementById('btn-reset').addEventListener('click', () => {
  const today  = new Date();
  const plus30 = new Date(today);
  plus30.setDate(plus30.getDate() + 30);
  const fmt = d => d.toISOString().slice(0, 10);
  document.getElementById('date-from').value = fmt(today);
  document.getElementById('date-to').value   = fmt(plus30);
  dateFrom = today;
  dateTo   = plus30;
  applyFilters();
});

// ── Address search (Geonorge) ─────────────────────────────────────────────────
const searchInput   = document.getElementById('search');
const suggestionBox = document.getElementById('suggestions');
let searchTimer = null;

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (q.length < 2) { hideSuggestions(); return; }
  searchTimer = setTimeout(() => fetchSuggestions(q), 280);
});

searchInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') hideSuggestions();
});

document.addEventListener('click', e => {
  if (!e.target.closest('#search-wrap')) hideSuggestions();
});

async function fetchSuggestions(q) {
  try {
    const url = `https://ws.geonorge.no/adresser/v1/sok?sok=${encodeURIComponent(q)}&kommunenummer=0301&treffPerSide=6&side=0`;
    const resp = await fetch(url);
    const data = await resp.json();
    showSuggestions(data.adresser || []);
  } catch { hideSuggestions(); }
}

function showSuggestions(items) {
  suggestionBox.innerHTML = '';
  if (!items.length) { hideSuggestions(); return; }
  items.forEach(addr => {
    const li = document.createElement('li');
    const label = [addr.adressetekst, addr.poststed].filter(Boolean).join(', ');
    li.textContent = label;
    li.addEventListener('click', () => {
      searchInput.value = label;
      hideSuggestions();
      const lng = addr.representasjonspunkt?.lon;
      const lat = addr.representasjonspunkt?.lat;
      if (lng && lat) {
        map.flyTo({ center: [lng, lat], zoom: 15, duration: 800 });
      }
    });
    suggestionBox.appendChild(li);
  });
  suggestionBox.classList.remove('hidden');
}

function hideSuggestions() {
  suggestionBox.innerHTML = '';
  suggestionBox.classList.add('hidden');
}

// ── Load on map ready + reload on move ───────────────────────────────────────
map.on('load', loadData);

let moveTimer = null;
map.on('moveend', () => {
  clearTimeout(moveTimer);
  moveTimer = setTimeout(loadData, 400);
});
