// Settings → "Online database (auto-sync)" card.
import { $, h, send, toast, timeAgo } from '../lib/dom.js';
import { usageInfo } from '../lib/db-usage.js';

let card = null;

function ensureCard() {
  const view = $('#view-settings');
  if (!view) return null;
  if (!card || !view.contains(card)) {
    card = h('div', { class: 'card', id: 'sync-card' });
    const engine = $('#engine-card');
    if (engine) engine.after(card); else view.append(card);
  }
  return card;
}

const pill = (st) => {
  const map = { ok: ['ok', 'Synced'], error: ['err', 'Error'], paused: ['warn', 'Paused'], off: ['', 'Not configured'] };
  const [cls, label] = map[st.state] || (st.configured ? ['', 'Starting…'] : ['', 'Not configured']);
  return h('span', { class: 'pill ' + cls }, label);
};

async function render() {
  const box = ensureCard();
  if (!box) return;
  let st = {};
  try { st = (await send('syncStatus')).status || {}; } catch (_) { /* background starting */ }
  const manual = (await chrome.storage.local.get('syncConfig')).syncConfig || {};
  const editing = box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
  if (editing) return; // don't wipe what the user is typing

  const field = (id, label, value, type = 'text', ph = '') => h('label', { class: 'sync-field' }, h('span', {}, label), h('input', { id, type, value: value || '', placeholder: ph, autocomplete: 'off', spellcheck: 'false' }));
  box.replaceChildren(
    h('h3', {}, 'Online database (auto-sync) ', pill(st)),
    h('p', { class: 'muted' }, 'Script data is saved locally first and uploaded automatically to Supabase every few seconds; changes from coworkers are downloaded every 30 seconds. Works offline: pending changes upload when the connection is back. The team token can add and update data but never delete it.'),
    h('dl', { class: 'sync-dl' },
      h('dt', {}, 'Config from'), h('dd', {}, st.source || (st.configured ? '—' : 'none: add team-config.json to the extension folder or fill the form below')),
      h('dt', {}, 'Database'), h('dd', {}, st.url || '—'),
      h('dt', {}, 'This computer'), h('dd', {}, h('span', {}, st.device || '—'), ' ', h('button', { class: 'small', onclick: renameDevice }, 'Rename')),
      h('dt', {}, 'Database size'), h('dd', { id: 'sync-usage' }, '…'),
      h('dt', {}, 'Size alert'), h('dd', {}, h('label', { title: 'Windows notification when the online database passes 80% (at most once a day). Only on this computer; teammates are not notified.' }, h('input', { type: 'checkbox', id: 'sync-notify', onchange: (e) => chrome.storage.local.set({ 'sync:notifyFull': e.target.checked }) }), ' Notify me on this computer when almost full')),
      h('dt', {}, 'Waiting to upload'), h('dd', {}, String(st.pending ?? 0)),
      h('dt', {}, 'Last sync'), h('dd', {}, st.lastSync ? `${timeAgo(st.lastSync)}${st.lastPushed ? ` · uploaded ${st.lastPushed}` : ''}${st.lastPulled ? ` · downloaded ${st.lastPulled}` : ''}` : '—'),
      st.error ? [h('dt', {}, 'Last error'), h('dd', { class: 'sync-err' }, st.error)] : null
    ),
    h('div', { class: 'row wrap', style: { margin: '8px 0 12px' } },
      h('button', { class: 'primary', onclick: syncNow, disabled: !st.configured }, 'Sync now'),
      h('button', { onclick: testConn, disabled: !st.configured }, 'Test connection'),
      h('button', { onclick: checkAll, disabled: !st.configured, title: 'Read every saved item back from the online database and re-upload anything missing or different' }, 'Check all saved online')
    ),
    h('details', { open: !st.configured },
      h('summary', {}, 'Set up / change (admin)'),
      h('p', { class: 'muted' }, 'Leave empty to use team-config.json from the extension folder (recommended for coworkers: they then need to do nothing). Use the PUBLIC anon key, never the service_role key.'),
      field('sync-url', 'Supabase URL', manual.supabaseUrl, 'url', 'https://xxxx.supabase.co'),
      field('sync-anon', 'Publishable (or legacy anon) key', manual.anonKey, 'password', 'sb_publishable_…'),
      field('sync-token', 'Team token', manual.teamToken, 'password', 'the long random team token'),
      h('label', { class: 'sync-check' }, h('input', { id: 'sync-enabled', type: 'checkbox', checked: manual.enabled !== false }), ' Auto-sync enabled'),
      h('div', { class: 'row', style: { marginTop: '8px' } },
        h('button', { class: 'primary', onclick: saveConfig }, 'Save & sync'),
        h('button', { onclick: clearConfig }, 'Use team-config.json')
      )
    )
  );
  chrome.storage.local.get('sync:notifyFull').then((o) => { const c = box.querySelector('#sync-notify'); if (c) c.checked = o['sync:notifyFull'] === true; });
  if (st.configured) send('syncUsage').then((r) => { const el = box.querySelector('#sync-usage'), u = usageInfo(r.usage); if (el) el.textContent = u ? u.text.replace(/^Online database: |^Database size: /, '') : '—'; if (el && u) el.className = 'usage-' + u.cls; }).catch(() => {});
}

async function syncNow() {
  const r = (await send('syncNow')).result;
  toast(r.state === 'ok' ? `Synced: ${r.pushed || 0} up, ${r.pulled || 0} down` : r.error || r.state, r.state === 'ok' ? 'ok' : 'err');
  render();
}
async function checkAll(e) {
  const b = e && e.currentTarget; if (b) { b.disabled = true; b.textContent = 'Checking…'; }
  try {
    const r = (await send('syncCheckAll')).result;
    if (r.state !== 'ok') toast(r.error || (r.state === 'paused' ? 'Auto-sync is paused' : 'Online database is not set up'), 'err');
    else if (!r.missing && !r.differ) toast(`All ${r.checked} saved items are online${r.deleted ? ` (${r.deleted} deleted online, kept deleted)` : ''}`, 'ok');
    else toast(`${r.missing ? r.missing + ' missing online: uploading them now.' : 'Nothing missing online.'}${r.differ ? ` ${r.differ} differ from the online copy: left as they are (use Save online now in the script to send yours).` : ''}`, 'err');
  } catch (err) { toast(err.message, 'err'); }
  render();
}
async function testConn() {
  const r = (await send('syncTest')).result;
  toast(r.ok ? 'Connection OK, team token accepted' : r.error, r.ok ? 'ok' : 'err');
}
async function saveConfig() {
  const url = $('#sync-url').value.trim();
  const anon = $('#sync-anon').value.trim();
  const token = $('#sync-token').value.trim();
  if (!url || !anon || !token) { toast('Fill URL, anon key and team token (or use team-config.json)', 'err'); return; }
  if (!/^https:\/\//.test(url)) { toast('The URL must start with https://', 'err'); return; }
  if (token.length < 24) { toast('Use a long random team token (24+ characters)', 'err'); return; }
  const r = (await send('syncSaveConfig', { config: { supabaseUrl: url, anonKey: anon, teamToken: token, enabled: $('#sync-enabled').checked } })).result;
  document.activeElement && document.activeElement.blur();
  toast(r.state === 'ok' ? 'Saved and synced' : r.error || r.state, r.state === 'ok' ? 'ok' : 'err');
  render();
}
async function clearConfig() {
  if (!confirm('Remove the settings saved here and use team-config.json from the extension folder?')) return;
  await send('syncSaveConfig', { config: null });
  render();
}
async function renameDevice() {
  const st = (await send('syncStatus')).status || {};
  const name = prompt('Name for this computer (shown with the data it uploads):', st.device || '');
  if (name == null) return;
  await send('syncSetDeviceName', { name });
  render();
}

window.addEventListener('si-view', (e) => { if (e.detail === 'settings') render(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes['sync:status'] || changes.syncConfig) && !$('#view-settings').classList.contains('hidden')) render();
});
if (new URLSearchParams(location.search).get('view') === 'settings') setTimeout(render, 300);
