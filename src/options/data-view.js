// Dashboard → "Data" view: browse, view, edit, export, import and delete the data each script
// stores through injector.storage (chrome.storage.local keys sdata:<scriptId>:<key> + sidx:<scriptId>).
import * as store from '../lib/storage.js';
import { $, h, toast, timeAgo, download } from '../lib/dom.js';

const SDATA = (id, key) => `sdata:${id}:${key}`;
const SIDX = (id) => `sidx:${id}`;
const D = { scriptId: null, key: null, filter: '', scripts: [], idx: {} };

const kb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B');
const fmtDate = (t) => (t ? new Date(t).toLocaleString() : '—');

async function loadIndex() {
  D.scripts = await store.getScripts();
  const all = await chrome.storage.local.get(null);
  D.idx = {};
  for (const [k, v] of Object.entries(all)) if (k.startsWith('sidx:')) D.idx[k.slice(5)] = v || {};
  D.all = all;
}

function scriptName(id) {
  const s = D.scripts.find((x) => x.id === id);
  return s ? s.name : id + ' (deleted script)';
}

/* ---------------- events overview (all event:* records from every script) ---------------- */
function renderEvents() {
  const rows = [];
  for (const [id, idx] of Object.entries(D.idx)) {
    for (const key of Object.keys(idx)) {
      if (!key.startsWith('event:')) continue;
      const v = D.all[SDATA(id, key)];
      if (v && typeof v === 'object') rows.push({ id, key, v });
    }
  }
  const box = $('#d-events');
  if (!rows.length) {
    box.replaceChildren(h('h3', {}, 'Events'), h('p', { class: 'muted' }, 'No event details stored yet. Open an event page with the Comp Tracker script on and its details are saved automatically.'));
    return;
  }
  rows.sort((a, b) => (b.v.updatedAt || 0) - (a.v.updatedAt || 0));
  const yesNo = (b) => (b === true ? h('span', { class: 'pill err' }, 'Hard disabled') : b === false ? h('span', { class: 'pill ok' }, 'Active') : h('span', { class: 'muted' }, '—'));
  box.replaceChildren(
    h('h3', {}, `Events (${rows.length})`),
    h('div', { class: 'data-tablewrap' }, h('table', { class: 'table data-table' },
      h('thead', {}, h('tr', {}, ['Event', 'Date / time', 'Venue', 'Status', 'Pricing', 'Tix left', 'Listings', 'Tix sold', 'Sales', 'Revenue', 'Updated', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, rows.map(({ id, key, v }) => h('tr', {},
        h('td', {}, h('b', {}, v.name || '—'), h('div', { class: 'muted' }, `#${v.eventId || ''}${v.posEventId ? ' · POS ' + v.posEventId : ''}`)),
        h('td', {}, `${v.dateText || ''} ${v.time || ''} ${v.timezone || ''}`.trim() || '—', v.altTime ? h('div', { class: 'muted' }, v.altTime) : null),
        h('td', {}, v.venue || '—', v.location ? h('div', { class: 'muted' }, v.location) : null),
        h('td', {}, v.status || '—'),
        h('td', {}, yesNo(v.hardDisabled)),
        h('td', {}, v.totalTix ?? '—'),
        h('td', {}, v.totalListings ?? '—'),
        h('td', {}, v.totalSold ?? '—'),
        h('td', {}, v.totalSales ?? '—'),
        h('td', {}, Number.isFinite(v.revenue) ? '$' + Math.round(v.revenue).toLocaleString() : '—'),
        h('td', { title: fmtDate(v.updatedAt) }, timeAgo(v.updatedAt)),
        h('td', {}, h('button', { class: 'small', onclick: () => { selectScript(id); openKey(key); } }, 'Open'))
      )))
    ))
  );
}

/* ---------------- scripts list ---------------- */
function renderScripts() {
  const ids = [...new Set([...Object.keys(D.idx), ...D.scripts.map((s) => s.id)])];
  const items = ids.map((id) => {
    const idx = D.idx[id] || {};
    const keys = Object.keys(idx);
    return { id, n: keys.length, size: keys.reduce((a, k) => a + (idx[k].size || 0), 0), updated: Math.max(0, ...keys.map((k) => idx[k].updated || 0)) };
  }).sort((a, b) => b.n - a.n || scriptName(a.id).localeCompare(scriptName(b.id)));
  $('#d-scripts').replaceChildren(
    h('h3', {}, 'Scripts'),
    h('ul', { class: 'data-slist' }, items.map((it) => h('li', {
      class: (it.id === D.scriptId ? 'active ' : '') + (it.n ? '' : 'empty'),
      onclick: () => selectScript(it.id)
    },
      h('div', { class: 'grow' }, h('div', { class: 'ellipsis' }, h('b', {}, scriptName(it.id))), h('div', { class: 'muted small-t' }, it.n ? `${it.n} key${it.n > 1 ? 's' : ''} · ${kb(it.size)} · ${timeAgo(it.updated)}` : 'no stored data'))
    )))
  );
}

/* ---------------- one script's keys ---------------- */
function summary(key, v) {
  if (v && typeof v === 'object' && Array.isArray(v.listings)) {
    const active = v.listings.filter((l) => !l.goneAt).length;
    return `${v.listings.length} listings (${active} active, ${v.listings.length - active} gone) · ${v.snapshots || 0} snapshots`;
  }
  if (key.startsWith('event:') && v && typeof v === 'object') return `${v.name || ''} · ${v.dateText || ''} ${v.time || ''} ${v.timezone || ''}`;
  if (Array.isArray(v)) return `array · ${v.length} items`;
  if (v && typeof v === 'object') return `object · ${Object.keys(v).length} fields`;
  return String(v).slice(0, 60);
}

function renderMain() {
  const box = $('#d-main');
  if (!D.scriptId) {
    box.replaceChildren(h('p', { class: 'muted' }, 'Pick a script to see its stored data.'));
    return;
  }
  const idx = D.idx[D.scriptId] || {};
  const keys = Object.keys(idx).filter((k) => !D.filter || k.toLowerCase().includes(D.filter.toLowerCase())).sort((a, b) => (idx[b].updated || 0) - (idx[a].updated || 0));
  const fileInput = h('input', { type: 'file', accept: '.json', class: 'hidden', onchange: (e) => importData(e.target.files[0]) });
  box.replaceChildren(
    h('div', { class: 'row wrap data-head' },
      h('h3', { class: 'grow' }, scriptName(D.scriptId)),
      h('input', { type: 'search', placeholder: 'Filter keys…', value: D.filter, style: { width: '200px' }, oninput: (e) => { D.filter = e.target.value; renderMain(); } }),
      h('button', { onclick: exportData, disabled: !Object.keys(idx).length }, 'Export'),
      h('button', { onclick: () => fileInput.click() }, 'Import'),
      h('button', { class: 'danger', onclick: deleteAll, disabled: !Object.keys(idx).length }, 'Delete all'),
      fileInput
    ),
    keys.length
      ? h('div', { class: 'data-tablewrap' }, h('table', { class: 'table data-table' },
        h('thead', {}, h('tr', {}, ['Key', 'Contents', 'Size', 'Updated', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, keys.map((k) => h('tr', { class: k === D.key ? 'sel' : '' },
          h('td', {}, h('code', {}, k)),
          h('td', { class: 'muted' }, summary(k, D.all[SDATA(D.scriptId, k)])),
          h('td', {}, kb(idx[k].size || 0)),
          h('td', { title: fmtDate(idx[k].updated) }, timeAgo(idx[k].updated)),
          h('td', { class: 'row' },
            h('button', { class: 'small', onclick: () => openKey(k) }, 'View / edit'),
            h('button', { class: 'small', onclick: () => download(`${D.scriptId}-${k.replace(/[^\w.-]+/g, '_')}.json`, JSON.stringify(D.all[SDATA(D.scriptId, k)], null, 2)) }, 'Download'),
            h('button', { class: 'small danger', onclick: () => deleteKey(k) }, 'Delete'))
        )))
      ))
      : h('p', { class: 'muted' }, Object.keys(idx).length ? 'No keys match the filter.' : 'This script has not stored any data.'),
    h('div', { id: 'd-editor' })
  );
  if (D.key && idx[D.key]) renderEditor();
}

/* ---------------- editor ---------------- */
function friendly(key, v) {
  if (key.startsWith('event:') && v && typeof v === 'object') {
    const fields = [
      ['Event', v.name], ['Event ID / POS ID', `${v.eventId || '—'} / ${v.posEventId || '—'}`], ['Date', v.dateText], ['Time', `${v.time || ''} ${v.timezone || ''}`.trim()],
      ['Other time', v.altTime], ['Event time (ISO)', v.dateISO], ['Venue', v.venue], ['Location', v.location], ['Status', v.status],
      ['Hard disabled', v.hardDisabled === true ? 'Yes' : v.hardDisabled === false ? 'No' : '—'], ['Tickets left (inventory)', v.totalTix], ['Listings', v.totalListings],
      ['Tickets sold', v.totalSold], ['Sales', v.totalSales], ['Revenue', Number.isFinite(v.revenue) ? '$' + v.revenue.toFixed(2) : '—'],
      ['Event list tickets', v.listTickets], ['Last sale (event list)', v.lastSale], ['Last presales', v.lastPresales], ['Next presales', v.nextPresales],
      ['Public onsale', v.publicOnsale], ['Assigned user', v.assignedUser], ['Zones', v.zones], ['Page', v.url], ['First stored', fmtDate(v.firstSeen)], ['Updated', fmtDate(v.updatedAt)]
    ];
    return h('dl', { class: 'data-dl' }, fields.flatMap(([k, val]) => [h('dt', {}, k), h('dd', {}, val == null || val === '' ? '—' : String(val))]));
  }
  if (v && typeof v === 'object' && Array.isArray(v.listings)) {
    const rows = v.listings.slice().sort((a, b) => (a.lp || 0) - (b.lp || 0)).slice(0, 200);
    return h('div', { class: 'data-tablewrap', style: { maxHeight: '260px' } }, h('table', { class: 'table data-table' },
      h('thead', {}, h('tr', {}, ['LP', 'Section', 'Row', 'Qty', 'Source', 'Ticket ID', 'Changes', 'First seen', 'Last seen', 'Status'].map((t) => h('th', {}, t)))),
      h('tbody', {}, rows.map((l) => h('tr', {},
        h('td', {}, '$' + Math.round(l.lp)), h('td', {}, l.section), h('td', {}, l.row), h('td', {}, l.qty), h('td', {}, l.src || '—'),
        h('td', {}, h('code', {}, l.tid || '—')), h('td', {}, l.changes || 0), h('td', {}, fmtDate(l.firstSeen)), h('td', {}, fmtDate(l.lastSeen)),
        h('td', {}, l.goneAt ? 'Gone ' + timeAgo(l.goneAt) : 'Active'))))
    ));
  }
  return null;
}

function openKey(key) {
  D.key = key;
  renderMain();
  const ed = $('#d-editor');
  if (ed) ed.scrollIntoView({ block: 'nearest' });
}

function renderEditor() {
  const v = D.all[SDATA(D.scriptId, D.key)];
  const text = JSON.stringify(v, null, 2);
  const ta = h('textarea', { rows: 14, spellcheck: 'false', class: 'data-json' });
  ta.value = text;
  const status = h('span', { class: 'muted' }, `${kb(text.length)} · JSON`);
  ta.addEventListener('input', () => {
    try { JSON.parse(ta.value); status.textContent = 'Valid JSON'; status.className = 'muted'; } catch (e) { status.textContent = 'Invalid JSON: ' + e.message; status.className = 'pill err'; }
  });
  const fr = friendly(D.key, v);
  $('#d-editor').replaceChildren(h('div', { class: 'data-editor' },
    h('div', { class: 'row' }, h('h3', { class: 'grow' }, h('code', {}, D.key)), h('button', { class: 'small', onclick: () => { D.key = null; renderMain(); } }, 'Close')),
    fr ? h('details', { open: true }, h('summary', {}, 'Overview'), fr) : null,
    h('details', { open: !fr }, h('summary', {}, 'Raw JSON (editable)'),
      ta,
      h('div', { class: 'row', style: { marginTop: '6px' } },
        status, h('span', { class: 'grow' }),
        h('button', { onclick: () => { try { ta.value = JSON.stringify(JSON.parse(ta.value), null, 2); } catch (_) { toast('Fix the JSON first', 'err'); } } }, 'Format'),
        h('button', { onclick: () => { ta.value = text; ta.dispatchEvent(new Event('input')); } }, 'Revert'),
        h('button', { class: 'primary', onclick: () => saveKey(D.key, ta.value) }, 'Save'))
    )
  ));
}

/* ---------------- writes (from the dashboard) ---------------- */
async function writeIndex(id, mutate) {
  const idx = (await chrome.storage.local.get(SIDX(id)))[SIDX(id)] || {};
  mutate(idx);
  await chrome.storage.local.set({ [SIDX(id)]: idx });
}

async function saveKey(key, text) {
  let value;
  try { value = JSON.parse(text); } catch (e) { toast('Invalid JSON: ' + e.message, 'err'); return; }
  if (!confirm(`Save changes to "${key}"? The running script will pick up the new data.`)) return;
  await chrome.storage.local.set({ [SDATA(D.scriptId, key)]: value });
  await writeIndex(D.scriptId, (idx) => { idx[key] = { ...(idx[key] || {}), updated: Date.now(), size: JSON.stringify(value).length }; });
  toast('Saved', 'ok');
  await refresh();
}

async function deleteKey(key) {
  if (!confirm(`Delete "${key}" from ${scriptName(D.scriptId)}? This cannot be undone.`)) return;
  await chrome.storage.local.remove(SDATA(D.scriptId, key));
  await writeIndex(D.scriptId, (idx) => { delete idx[key]; });
  if (D.key === key) D.key = null;
  toast('Deleted');
  await refresh();
}

async function deleteAll() {
  const keys = Object.keys(D.idx[D.scriptId] || {});
  if (!keys.length || !confirm(`Delete ALL ${keys.length} stored keys of ${scriptName(D.scriptId)}? This cannot be undone.`)) return;
  await chrome.storage.local.remove([...keys.map((k) => SDATA(D.scriptId, k)), SIDX(D.scriptId)]);
  D.key = null;
  toast('All data deleted');
  await refresh();
}

function exportData() {
  const idx = D.idx[D.scriptId] || {};
  const data = {};
  for (const k of Object.keys(idx)) data[k] = D.all[SDATA(D.scriptId, k)];
  download(`script-data-${scriptName(D.scriptId).replace(/[^\w.-]+/g, '_')}-${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify({ format: 'script-injector-data', scriptId: D.scriptId, exportedAt: new Date().toISOString(), data }, null, 2));
}

async function importData(file) {
  if (!file) return;
  let json;
  try { json = JSON.parse(await file.text()); } catch (e) { toast('Not a JSON file', 'err'); return; }
  const data = json && json.format === 'script-injector-data' ? json.data : json;
  if (!data || typeof data !== 'object' || Array.isArray(data)) { toast('Expected an object of key → value', 'err'); return; }
  const keys = Object.keys(data);
  if (!confirm(`Import ${keys.length} key(s) into ${scriptName(D.scriptId)}? Existing keys with the same name are replaced.`)) return;
  const out = {};
  for (const k of keys) out[SDATA(D.scriptId, k)] = data[k];
  await chrome.storage.local.set(out);
  await writeIndex(D.scriptId, (idx) => { for (const k of keys) idx[k] = { updated: Date.now(), size: JSON.stringify(data[k]).length }; });
  toast(`Imported ${keys.length} key(s)`, 'ok');
  await refresh();
}

/* ---------------- wiring ---------------- */
async function refresh() {
  await loadIndex();
  renderEvents();
  renderScripts();
  renderMain();
}
function selectScript(id) {
  D.scriptId = id;
  D.key = null;
  D.filter = '';
  renderScripts();
  renderMain();
}

$('#d-refresh').addEventListener('click', refresh);
window.addEventListener('si-view', (e) => { if (e.detail === 'data') refresh(); });
window.addEventListener('si-data-select', async (e) => { await refresh(); selectScript(e.detail); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || $('#view-data').classList.contains('hidden')) return;
  if (Object.keys(changes).some((k) => k.startsWith('sidx:') || k.startsWith('sdata:'))) {
    clearTimeout(refresh.t);
    refresh.t = setTimeout(async () => {
      const editing = document.activeElement && document.activeElement.classList.contains('data-json');
      await loadIndex();
      renderEvents();
      renderScripts();
      if (!editing) renderMain(); // never overwrite JSON the user is editing
    }, 400);
  }
});

// Deep link: options.html?view=data&script=<id>
const params = new URLSearchParams(location.search);
if (params.get('view') === 'data') {
  refresh().then(() => { if (params.get('script')) selectScript(params.get('script')); });
}
