import { siMatch, patternKind, validatePattern } from '../lib/matcher.js';
import * as store from '../lib/storage.js';
import { $, $$, h, send, toast, timeAgo, download, toggle } from '../lib/dom.js';
import { setupEditor } from '../lib/editor.js';
import * as installer from '../lib/installer.js';
import * as control from '../lib/control.js';
import * as gh from '../lib/gh.js';
import { icon } from '../lib/icons.js';
import { sourceGroup as srcGroup, SOURCE_ORDER } from '../lib/sources.js';
import { setupLock } from '../lib/lock-ui.js';

const state = {
  scripts: [],
  settings: { ...store.DEFAULT_SETTINGS },
  stats: {},
  logs: [],
  updates: {}, // update-check state per script id
  engine: null,
  currentId: null,
  draft: null, // unsaved new script
  loaded: null, // last saved version of the script in the editor
  view: 'scripts',
  syntax: { ok: true }
};

const params = new URLSearchParams(location.search);

// Locked managed copy (not admin): script code is never shown, exported or searched
let hideCode = false;
try { hideCode = !!((await control.lockInfo()) || {}).locked; } catch { /* not managed */ }

// Script list groups (collapsed ones remembered per browser)
let collapsed = new Set();
try { collapsed = new Set(JSON.parse(localStorage.getItem('si-collapsed') || '[]')); } catch { /* none */ }
function saveCollapsed() { try { localStorage.setItem('si-collapsed', JSON.stringify([...collapsed])); } catch { /* ignore */ } }
const sourceGroup = (s) => srcGroup(s, state.scripts);

/* =====================================================================
 * Data loading
 * =================================================================== */

async function loadData() {
  const [scripts, settings, stats, logs, updates] = await Promise.all([store.getScripts(), store.getSettings(), store.getStats(), store.getLogs(), installer.getState()]);
  Object.assign(state, { scripts, settings, stats, logs, updates });
}

async function loadEngine() {
  try {
    state.engine = (await send('engine')).engine;
  } catch {
    state.engine = null;
  }
  renderEngine();
}

/* =====================================================================
 * Views / header
 * =================================================================== */

function setView(view, push = true) {
  state.view = view;
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== 'view-' + view));
  if (view === 'logs') renderLogs();
  if (view === 'tester') renderTester();
  if (view === 'settings') renderSettings();
  window.dispatchEvent(new CustomEvent('si-view', { detail: view }));
  if (push) {
    const p = new URLSearchParams(location.search);
    p.set('view', view);
    ['log', 'new', 'welcome'].forEach((k) => p.delete(k));
    if (view !== 'scripts') p.delete('edit');
    history.replaceState(null, '', '?' + p);
  }
}

function renderHeader() {
  $('#global-toggle').checked = state.settings.enabled;
  $('#global-label').textContent = state.settings.enabled ? 'On' : 'Off';
  const errs = state.logs.filter((l) => l.level === 'error').length;
  const pill = $('#log-count');
  pill.textContent = errs > 999 ? '999+' : errs;
  pill.classList.toggle('hidden', !errs);
}

function renderEngine() {
  const e = state.engine;
  const pill = $('#engine-pill');
  if (!e) {
    pill.textContent = 'engine ?';
    pill.className = 'pill';
  } else if (e.userScripts) {
    pill.textContent = 'User Scripts engine';
    pill.className = 'pill ok';
    pill.title = e.execute ? 'Full feature set' : 'Instant reinject uses fallback (needs Chrome 135+)';
  } else {
    pill.textContent = 'Limited mode';
    pill.className = 'pill warn';
    pill.title = 'Enable "Allow User Scripts" for this extension';
  }
  const slot = $('#banner-slot');
  slot.replaceChildren();
  if (e && !e.userScripts) {
    slot.append(h('div', { class: 'banner' },
      h('div', { class: 'grow' },
        h('b', {}, 'Running in limited mode'),
        'Scripts are injected with <script> tags, so pages with a strict Content-Security-Policy can block them. Turn on ',
        h('b', { style: { display: 'inline' } }, 'Allow User Scripts'),
        ' (Chrome 138+) or ', h('b', { style: { display: 'inline' } }, 'Developer mode'), ' (older Chrome) for this extension.'
      ),
      h('button', { onclick: () => send('openUserScriptsSettings') }, 'Open extension settings'),
      h('button', { onclick: async () => { await send('resync'); await loadEngine(); toast(state.engine && state.engine.userScripts ? 'User Scripts engine enabled ✓' : 'Still in limited mode', state.engine && state.engine.userScripts ? 'ok' : 'err'); } }, 'Re-check')
    ));
  }
  if (state.view === 'settings') renderSettings();
}

/* =====================================================================
 * Script list
 * =================================================================== */

function allScriptsForList() {
  return state.draft ? [state.draft, ...state.scripts] : state.scripts;
}

function renderList() {
  const q = $('#search').value.trim().toLowerCase();
  const f = $('#filter').value;
  const list = allScriptsForList().filter((s) => {
    if (f === 'enabled' && !s.enabled) return false;
    if (f === 'disabled' && s.enabled) return false;
    if (f === 'js' && s.type !== 'js') return false;
    if (f === 'css' && s.type !== 'css') return false;
    if (f === 'manual' && s.runAt !== 'manual') return false;
    if (f === 'errors' && !(state.stats[s.id] && state.stats[s.id].errors)) return false;
    if (!q) return true;
    return [s.name, s.description, hideCode ? '' : s.code, ...s.include, ...s.exclude].join('\n').toLowerCase().includes(q);
  });

  const ul = $('#script-list');
  if (!list.length && !(knownSources.length && !q && f === 'all')) {
    ul.replaceChildren(...pendingLibRows(), h('li', { class: 'empty' }, state.scripts.length ? 'No scripts match the filter.' : pendingLibs.length ? 'Connect a library above to install its scripts.' : 'No scripts yet.'));
  } else {
    const rows = (s) => {
      const st = state.stats[s.id];
      const isDraft = state.draft && s.id === state.draft.id;
      const dot = !s.enabled ? 'off' : st && st.errors ? 'err' : st && st.runs ? 'ok' : '';
      const where = s.runAt === 'manual' ? 'manual' : s.include[0] || 'no include pattern';
      return h('li', {
        class: (s.id === state.currentId ? 'active ' : '') + (s.enabled ? '' : 'off'),
        onclick: () => selectScript(s.id)
      },
        h('span', { class: 'dot ' + dot, title: st ? `${st.runs} runs · ${st.errors} errors` : 'never ran' }),
        h('div', { class: 'grow' },
          h('div', { class: 's-name ellipsis' }, s.name, isDraft ? h('span', { class: 'muted' }, ' (unsaved)') : ''),
          h('div', { class: 's-meta ellipsis', title: s.include.join('\n') }, `${s.version ? 'v' + s.version + ' · ' : ''}${s.type.toUpperCase()} · ${where}${s.include.length > 1 ? ` +${s.include.length - 1}` : ''}`,
            (() => { const u = state.updates[s.id]; return u && u.latest > s.version ? h('span', { class: 'upd-badge', title: u.edited ? 'Update available. You edited this script, so it was not replaced automatically.' : 'Update available' }, ` ↑ v${u.latest}`) : null; })(),
            (() => { const p = s.enabled ? store.depProblems(s, state.scripts) : []; return p.length ? h('span', { class: 'dep-warn', title: 'This script does not run until its required scripts are on' }, ` · ⚠ needs ${p.map((x) => x.name).join(', ')}`) : s.dependsOn && s.dependsOn.length ? h('span', { class: 'muted', title: 'Required scripts: ' + s.dependsOn.map((id) => (state.scripts.find((x) => x.id === id) || {}).name || id).join(', ') }, ` · needs ${s.dependsOn.length}`) : null; })())
        ),
        isDraft || !s.sourceUrl ? null : h('button', { class: 'ghost icon upd-one' + (state.updates[s.id] && state.updates[s.id].latest > s.version ? ' has-upd' : ''), title: state.updates[s.id] && state.updates[s.id].latest > s.version ? `Update to v${state.updates[s.id].latest}` : 'Check this script for an update', onclick: async (e) => {
        e.stopPropagation(); const b = e.currentTarget; b.disabled = true; b.classList.add('spin');
        try { const r = await installer.updateOne(s.id); toast(r.msg, r.ok ? 'ok' : 'err'); } catch (err) { toast(err.message, 'err'); }
        b.disabled = false; b.classList.remove('spin'); } }, icon('refresh')),
        isDraft ? null : h('span', { onclick: (e) => e.stopPropagation() }, toggle(s.enabled, async (v) => {
          const r = await store.setEnabledWithDeps(s.id, v);
          if (r.also.length) toast(`${v ? 'Also turned on (required)' : 'Also turned off (they need it)'}: ${r.also.join(', ')}`, 'ok');
        }, 'Enable / disable'))
      );
    };
    // Grouped by where each script comes from: GitHub repo, folder, single link, or this computer
    const groups = new Map();
    for (const s of list) {
      const g = sourceGroup(s);
      if (!groups.has(g.key)) groups.set(g.key, { ...g, items: [] });
      groups.get(g.key).items.push(s);
    }
    const ORDER = SOURCE_ORDER;
    if (!q && f === 'all') for (const src of knownSources) if (!groups.has(src.key)) groups.set(src.key, { ...src, items: [] });
    for (const src of knownSources) if (groups.has(src.key)) Object.assign(groups.get(src.key), { note: src.note, icon: src.icon, tag: src.tag });
    const sorted = [...groups.values()].sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.label.localeCompare(b.label));
    ul.replaceChildren(...pendingLibRows(), ...sorted.flatMap((g) => {
      const closed = collapsed.has(g.key);
      const on = g.items.filter((s) => s.enabled).length;
      return [
        h('li', { class: 'grp' + (closed ? ' closed' : ''), title: g.title, onclick: () => { closed ? collapsed.delete(g.key) : collapsed.add(g.key); saveCollapsed(); renderList(); } },
          h('span', { class: 'grp-caret' }, closed ? '▸' : '▾'),
          icon(g.icon),
          h('span', { class: 'grp-name ellipsis' }, g.label),
          g.tag ? h('span', { class: 'grp-tag' }, g.tag) : null,
          g.kind === 'localdir' && !g.items.length ? h('span', { class: 'grp-x', title: 'Forget this folder', onclick: async (e) => { e.stopPropagation(); const lf = ((await chrome.storage.local.get('localFolders')).localFolders || []).filter((x) => 'local:' + x !== g.key); await chrome.storage.local.set({ localFolders: lf }); } }, '✕') : null,
          h('span', { class: 'grp-count', title: g.note || '' }, `${on}/${g.items.length}`)),
        // related scripts together: what a script needs comes right before it
        ...(closed ? [] : g.items.length ? store.sortByDeps(g.items).map(rows) : [h('li', { class: 'empty-grp' }, g.note ? g.note + ' · no scripts yet' : 'No scripts')])
      ];
    }));
  }
  const on = state.scripts.filter((s) => s.enabled).length;
  $('#side-foot').textContent = `${state.scripts.length} scripts · ${on} enabled`;
}

/* =====================================================================
 * Editor
 * =================================================================== */

const F = {
  name: $('#f-name'),
  enabled: $('#f-enabled'),
  description: $('#f-description'),
  type: $('#f-type'),
  runAt: $('#f-runAt'),
  world: $('#f-world'),
  delay: $('#f-delay'),
  include: $('#f-include'),
  exclude: $('#f-exclude'),
  allFrames: $('#f-allFrames'),
  runOnSpa: $('#f-runOnSpa'),
  reloadOnDisable: $('#f-reloadOnDisable'),
  wrap: $('#f-wrap'),
  captureConsole: $('#f-captureConsole'),
  requires: $('#f-requires'),
  sourceUrl: $('#f-sourceUrl'),
  autoUpdate: $('#f-autoUpdate'),
  code: $('#f-code')
};

const editor = setupEditor(F.code, $('#gutter'), {
  onSave: (withReinject) => save(withReinject),
  onChange: () => {
    updateDirty();
    scheduleSyntax();
  },
  getMode: () => F.type.value
});

function currentScript() {
  if (state.draft && state.draft.id === state.currentId) return state.draft;
  return state.scripts.find((s) => s.id === state.currentId) || null;
}

function fillForm(s) {
  F.name.value = s.name;
  F.enabled.checked = s.enabled;
  F.description.value = s.description;
  F.type.value = s.type;
  F.runAt.value = s.runAt;
  F.world.value = s.world;
  F.delay.value = s.delay;
  F.include.value = s.include.join('\n');
  F.exclude.value = s.exclude.join('\n');
  F.allFrames.checked = s.allFrames;
  F.runOnSpa.checked = s.runOnSpa;
  F.reloadOnDisable.checked = s.reloadOnDisable;
  F.wrap.checked = s.wrap;
  F.captureConsole.checked = s.captureConsole;
  F.requires.value = s.requires.join('\n');
  F.sourceUrl.value = s.sourceUrl || '';
  F.autoUpdate.checked = s.autoUpdate !== false;
  renderDepends(s);
  F.code.value = hideCode ? '' : s.code; // non-admins never see the code
  $('.code-box').classList.toggle('code-hidden', hideCode);
  editor.setError(0);
  editor.refresh();
  F.code.scrollTop = 0;
  onTypeChange();
  renderPatternHints();
  renderQuickTest();
  renderStats();
  renderUpdRow(s);
  updateDirty();
  scheduleSyntax(0);
}

function readForm() {
  const base = currentScript() || store.defaultScript();
  return store.normalizeScript({
    ...base,
    name: F.name.value.trim() || 'Untitled',
    enabled: F.enabled.checked,
    description: F.description.value.trim(),
    type: F.type.value,
    runAt: F.runAt.value,
    world: F.world.value,
    delay: F.delay.value,
    include: store.toList(F.include.value),
    exclude: store.toList(F.exclude.value),
    allFrames: F.allFrames.checked,
    runOnSpa: F.runOnSpa.checked,
    reloadOnDisable: F.reloadOnDisable.checked,
    wrap: F.wrap.checked,
    captureConsole: F.captureConsole.checked,
    requires: store.toList(F.requires.value),
    dependsOn: [...document.querySelectorAll('#f-depends input:checked')].map((i) => i.value),
    sourceUrl: F.sourceUrl.value.trim(),
    autoUpdate: F.autoUpdate.checked,
    version: hideCode ? base.version : headerVersion(F.code.value, base.version),
    code: hideCode ? base.code : F.code.value
  });
}

// "Required scripts": other scripts this one needs (turned on together, injected first, never runs without them)
function renderDepends(s) {
  const box = $('#f-depends');
  if (!box) return;
  const others = state.scripts.filter((x) => x.id !== s.id);
  const needsMe = new Set(store.dependents(s.id, state.scripts).map((x) => x.id));
  box.replaceChildren(...(others.length ? others.map((o) => h('label', { class: 'dep-item', title: needsMe.has(o.id) ? 'This script already needs the current one (would be a loop)' : o.description || '' },
    h('input', { type: 'checkbox', value: o.id, checked: (s.dependsOn || []).includes(o.id), disabled: needsMe.has(o.id), onchange: () => { updateDirty(); renderDependsCount(); } }),
    h('span', {}, o.name), o.enabled ? null : h('span', { class: 'pill' }, 'off'))) : [h('span', { class: 'muted' }, 'No other scripts yet.')]));
  renderDependsCount();
}
function renderDependsCount() {
  const n = document.querySelectorAll('#f-depends input:checked').length;
  const c = $('#depends-count');
  if (c) c.textContent = n ? `(${n})` : '';
}

const EDITABLE = ['name', 'enabled', 'description', 'type', 'runAt', 'world', 'delay', 'include', 'exclude', 'allFrames', 'runOnSpa', 'reloadOnDisable', 'wrap', 'captureConsole', 'requires', 'dependsOn', 'sourceUrl', 'autoUpdate', 'code'];
const sig = (s) => JSON.stringify(EDITABLE.map((k) => s[k]));

function isDirty() {
  if (!state.currentId) return false;
  if (state.draft && state.draft.id === state.currentId) return true;
  return !!state.loaded && sig(readForm()) !== sig(state.loaded);
}

function updateDirty() {
  const d = isDirty();
  $('#dirty-pill').classList.toggle('hidden', !d);
  $('#btn-revert').disabled = !d || !!(state.draft && state.draft.id === state.currentId);
  document.title = (d ? '● ' : '') + 'Script Injector — Dashboard';
}

function confirmDiscard() {
  return !isDirty() || confirm('You have unsaved changes. Discard them?');
}

function selectScript(id, { force = false } = {}) {
  if (id === state.currentId && !force) return;
  if (!force && !confirmDiscard()) return;
  if (state.draft && state.draft.id !== id) state.draft = null;
  state.currentId = id;
  const s = currentScript();
  $('#empty-editor').classList.toggle('hidden', !!s);
  $('#editor').classList.toggle('hidden', !s);
  if (s) {
    state.loaded = state.draft && state.draft.id === id ? null : s;
    fillForm(s);
    const p = new URLSearchParams(location.search);
    p.set('view', 'scripts');
    p.set('edit', id);
    ['new', 'log', 'welcome'].forEach((k) => p.delete(k));
    history.replaceState(null, '', '?' + p);
  }
  renderList();
}

function newScript(overrides = {}) {
  if (!confirmDiscard()) return;
  state.draft = store.defaultScript({
    code: "// Runs on every page matching the include patterns.\n// `injector`, `await` and `return` are available (see Help).\n\nconsole.log('Hello from', injector.name, 'on', location.href);\n",
    ...overrides
  });
  setView('scripts');
  selectScript(state.draft.id, { force: true });
  F.name.focus();
  F.name.select();
}

function onTypeChange() {
  const css = F.type.value === 'css';
  $('#editor').classList.toggle('css-mode', css);
  $('#mode-pill').textContent = css ? 'CSS' : 'JavaScript';
  F.delay.disabled = !F.wrap.checked;
  F.captureConsole.disabled = !F.wrap.checked;
  const n = store.toList(F.requires.value).length;
  $('#requires-count').textContent = n ? `(${n})` : '';
}

function renderPatternHints() {
  for (const [field, slot] of [[F.include, '#include-hints'], [F.exclude, '#exclude-hints']]) {
    const pills = store.toList(field.value).map((p) => {
      const err = validatePattern(p);
      return h('span', { class: 'pill ' + (err ? 'err' : 'accent'), title: err || p }, err ? '⚠ invalid regex' : patternKind(p));
    });
    $(slot).replaceChildren(...pills);
  }
  if (F.type.value !== 'css' && F.runAt.value !== 'manual' && !store.toList(F.include.value).length) {
    $('#include-hints').append(h('span', { class: 'pill warn' }, 'No include pattern: script will never run automatically. Use * for all sites.'));
  }
}

function renderQuickTest() {
  const url = $('#f-test-url').value.trim();
  const out = $('#f-test-result');
  if (!url) {
    out.textContent = '—';
    out.className = 'pill';
    out.title = '';
    return;
  }
  const r = siMatch(url, store.toList(F.include.value), store.toList(F.exclude.value), true);
  const paused = state.settings.disabledHosts.includes(store.hostOf(url));
  if (r.matched && paused) {
    out.textContent = 'matches, but site is paused';
    out.className = 'pill warn';
  } else if (r.matched) {
    out.textContent = '✓ runs here';
    out.className = 'pill ok';
  } else {
    out.textContent = r.include && r.exclude ? '✗ excluded' : '✗ no match';
    out.className = 'pill err';
  }
  out.title = r.include ? `include: ${r.include}${r.exclude ? `\nexcluded by: ${r.exclude}` : ''}` : 'No include pattern matched';
}

function renderStats() {
  const s = currentScript();
  const st = s && state.stats[s.id];
  const el = $('#script-stats');
  if (!s || (state.draft && state.draft.id === s.id)) {
    el.textContent = 'New script: not saved yet';
    return;
  }
  el.replaceChildren(
    `Saved ${timeAgo(s.updatedAt)} · `,
    st ? `${st.runs} runs (last ${timeAgo(st.lastRun)}) · ` : 'never ran · ',
    st && st.errors
      ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); $('#log-script').value = s.id; setView('logs'); } }, `${st.errors} errors`)
      : '0 errors'
  );
}

/* ---------- syntax check (sandboxed iframe) ---------- */

const sandbox = $('#sandbox');
let sandboxReady;
const sandboxReadyP = new Promise((r) => (sandboxReady = r));
const pending = new Map();
let seq = 0;
window.addEventListener('message', (e) => {
  if (e.source !== sandbox.contentWindow) return;
  if (e.data && e.data.sandboxReady) return sandboxReady();
  const res = pending.get(e.data && e.data.id);
  if (res) {
    pending.delete(e.data.id);
    res(e.data);
  }
});

// Handshake: ping until the sandbox answers (its load may happen before or after this module runs).
(function pingSandbox(n = 0) {
  let ready = false;
  sandboxReadyP.then(() => (ready = true));
  const tick = () => {
    if (ready || n++ > 50) return;
    try { sandbox.contentWindow.postMessage({ ping: true }, '*'); } catch { /* not loaded yet */ }
    setTimeout(tick, 100);
  };
  tick();
})();

async function checkSyntax(code, mode) {
  await Promise.race([sandboxReadyP, new Promise((r) => setTimeout(r, 3000))]);
  return new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    sandbox.contentWindow.postMessage({ id, code, mode }, '*');
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve({ ok: true, skipped: true });
      }
    }, 2000);
  });
}

let syntaxTimer;
function scheduleSyntax(delay = 450) {
  clearTimeout(syntaxTimer);
  syntaxTimer = setTimeout(runSyntax, delay);
}

async function runSyntax() {
  const el = $('#syntax-status');
  if (F.type.value === 'css') {
    state.syntax = { ok: true };
    el.textContent = '';
    editor.setError(0);
    return state.syntax;
  }
  const r = await checkSyntax(F.code.value, F.wrap.checked ? 'wrap' : 'plain');
  state.syntax = r;
  if (r.ok) {
    el.textContent = r.skipped ? '' : '✓ No syntax errors';
    el.className = 'syntax ok';
    el.onclick = null;
    editor.setError(0);
  } else {
    el.textContent = `✗ Line ${r.error.line}: ${r.error.message.replace(/^Uncaught /, '')}`;
    el.className = 'syntax err';
    el.title = 'Click to jump to the line';
    el.onclick = () => editor.goTo(r.error.line);
    editor.setError(r.error.line);
  }
  return r;
}

/* ---------- save / actions ---------- */

async function save(withReinject = false) {
  const s = readForm();
  const before = state.loaded;
  const syn = await runSyntax();
  if (!syn.ok && !confirm(`Syntax error on line ${syn.error.line}:\n${syn.error.message}\n\nThe script will fail to run. Save anyway?`)) return;
  const badRegex = [...s.include, ...s.exclude].map(validatePattern).filter(Boolean);
  if (badRegex.length && !confirm('Invalid pattern(s):\n' + badRegex.join('\n') + '\n\nSave anyway?')) return;

  if (s.type === 'js' && s.requires.length) {
    $('#requires-status').textContent = 'Downloading @require libraries…';
    const r = await store.fetchRequires(s.requires);
    $('#requires-status').textContent = r.errors.length ? 'Failed: ' + r.errors.join('; ') : 'Libraries cached ✓';
    if (r.errors.length) toast('Some @require URLs failed to download', 'err');
  }

  const saved = await store.upsertScript(s);
  state.draft = null;
  state.loaded = saved;
  state.currentId = saved.id;
  await loadData();
  state.loaded = state.scripts.find((x) => x.id === saved.id) || saved;
  renderList();
  renderStats();
  updateDirty();
  history.replaceState(null, '', '?view=scripts&edit=' + saved.id);

  if (withReinject) {
    const codeChanged = !before || before.code !== saved.code || sig(before) !== sig(saved);
    if (state.settings.autoReinjectOnSave && codeChanged && saved.type === 'js') {
      toast('Saved. Hot reload will reinject into open tabs.', 'ok');
    } else {
      try {
        const r = await send('reinjectScript', { scriptId: saved.id });
        toast(`Saved and reinjected into ${r.tabs} tab(s)`, 'ok');
      } catch (e) {
        toast('Saved, but reinject failed: ' + e.message, 'err');
      }
    }
  } else {
    toast('Saved', 'ok');
  }
}

async function targetTab() {
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((t) => store.isInjectableUrl(t.url))
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0) || (b.active ? 1 : 0) - (a.active ? 1 : 0))[0] || null;
}

$('#btn-save').addEventListener('click', () => save(false));
$('#btn-save-reinject').addEventListener('click', () => save(true));
$('#btn-revert').addEventListener('click', () => {
  if (state.loaded && confirm('Revert to the last saved version?')) fillForm(state.loaded);
});
$('#btn-delete').addEventListener('click', async () => {
  const s = currentScript();
  if (!s) return;
  if (state.draft && state.draft.id === s.id) {
    state.draft = null;
    state.currentId = null;
    selectScript(null, { force: true });
    return;
  }
  if (!confirm(`Delete “${s.name}”? This cannot be undone.`)) return;
  await store.deleteScript(s.id);
  state.loaded = null;
  state.currentId = null;
  await loadData();
  selectScript(null, { force: true });
  toast('Deleted');
});
$('#btn-duplicate').addEventListener('click', async () => {
  const s = readForm();
  const copy = store.normalizeScript({ ...s, id: store.newId(), name: s.name + ' (copy)', enabled: false, createdAt: Date.now() });
  await store.upsertScript(copy);
  await loadData();
  selectScript(copy.id, { force: true });
  toast('Duplicated (disabled)', 'ok');
});
$('#btn-script-data').addEventListener('click', () => {
  const s = currentScript();
  if (!s) return;
  setView('data');
  window.dispatchEvent(new CustomEvent('si-data-select', { detail: s.id }));
});
$('#btn-export-one').addEventListener('click', () => {
  const s = readForm();
  download(`${store.normalizeScript(s).name.replace(/[^\w.-]+/g, '_')}.script-injector.json`, JSON.stringify({ format: 'script-injector', version: 1, scripts: [s] }, null, 2));
});
$('#btn-run-tab').addEventListener('click', async () => {
  const s = currentScript();
  if (!s || (state.draft && state.draft.id === s.id) || isDirty()) {
    toast('Save the script first', 'err');
    return;
  }
  const tab = await targetTab();
  if (!tab) return toast('No scriptable tab open', 'err');
  try {
    await send('runScript', { tabId: tab.id, scriptId: s.id });
    toast(`Ran in “${tab.title}”`, 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
});
$('#btn-refresh-requires').addEventListener('click', async () => {
  const urls = store.toList(F.requires.value);
  if (!urls.length) return;
  $('#requires-status').textContent = 'Downloading…';
  const r = await store.fetchRequires(urls, true);
  $('#requires-status').textContent = r.errors.length ? 'Failed: ' + r.errors.join('; ') : `Re-downloaded ${urls.length} librar${urls.length > 1 ? 'ies' : 'y'} ✓`;
});

for (const el of Object.values(F)) {
  if (el === F.code) continue;
  el.addEventListener('input', () => {
    updateDirty();
    if (el === F.include || el === F.exclude || el === F.runAt) {
      renderPatternHints();
      renderQuickTest();
    }
    if (el === F.type || el === F.wrap || el === F.requires) {
      onTypeChange();
      scheduleSyntax(0);
    }
  });
  el.addEventListener('change', updateDirty);
}
$('#f-test-url').addEventListener('input', renderQuickTest);
$('#editor').addEventListener('submit', (e) => e.preventDefault());
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && state.view === 'scripts' && state.currentId && e.target !== F.code) {
    e.preventDefault();
    save(e.shiftKey);
  }
});
window.addEventListener('beforeunload', (e) => {
  if (isDirty()) e.preventDefault();
});

/* =====================================================================
 * Import / export
 * =================================================================== */

let importContext = 'scripts';
$('#btn-import').addEventListener('click', () => {
  importContext = 'scripts';
  $('#file-input').click();
});
$('#btn-export-all').addEventListener('click', () => {
  download(`script-injector-scripts-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ format: 'script-injector', version: 1, exportedAt: new Date().toISOString(), scripts: state.scripts }, null, 2));
});
$('#file-input').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  const jsFiles = files.filter((f) => /\.js$/i.test(f.name));
  if (jsFiles.length && importContext === 'scripts') {
    const items = await Promise.all(jsFiles.map(async (f) => installer.fromCode(await f.text(), '', f.name)));
    openInstall(items);
    if (jsFiles.length === files.length) return;
  }
  const incoming = [];
  let importedSettings = null;
  for (const file of files) {
    const text = await file.text();
    try {
      if (/\.js$/i.test(file.name)) {
        if (importContext === 'scripts') continue; // handled by the install preview
        incoming.push(store.parseUserScript(text, file.name));
      } else {
        const data = JSON.parse(text);
        const list = Array.isArray(data) ? data : data.scripts ? data.scripts : data.code != null ? [data] : [];
        incoming.push(...list.map(store.normalizeScript));
        if (data.settings) importedSettings = data.settings;
      }
    } catch (err) {
      toast(`Could not read ${file.name}: ${err.message}`, 'err');
      return;
    }
  }
  if (!incoming.length && !importedSettings) return jsFiles.length ? undefined : toast('Nothing to import', 'err');

  let list = [...state.scripts];
  if (importContext === 'settings' && incoming.length && confirm(`Replace ALL existing scripts with the ${incoming.length} from the backup?\n\nOK = replace everything · Cancel = merge`)) {
    list = [];
  }
  const ids = new Set(list.map((s) => s.id));
  const clashes = incoming.filter((s) => ids.has(s.id));
  const overwrite = clashes.length ? confirm(`${clashes.length} script(s) already exist with the same ID.\n\nOK = overwrite them · Cancel = import as copies`) : false;
  for (const s of incoming) {
    if (ids.has(s.id)) {
      if (overwrite) list = list.map((x) => (x.id === s.id ? s : x));
      else list.push({ ...s, id: store.newId(), name: s.name + ' (imported)' });
    } else {
      list.push(s);
    }
  }
  await store.setScripts(list);
  const reqs = [...new Set(incoming.flatMap((s) => s.requires))];
  if (reqs.length) {
    const r = await store.fetchRequires(reqs);
    if (r.errors.length) toast('Some @require downloads failed. See the script editor.', 'err');
  }
  if (importedSettings && importContext === 'settings' && confirm('The backup also contains settings. Apply them?')) {
    await store.saveSettings(importedSettings);
  }
  await loadData();
  renderAll();
  toast(`Imported ${incoming.length} script(s)`, 'ok');
});

/* =====================================================================
 * Logs
 * =================================================================== */

function filteredLogs() {
  const lvl = $('#log-level').value;
  const sid = $('#log-script').value;
  const q = $('#log-search').value.trim().toLowerCase();
  return state.logs.filter((l) => {
    if (lvl !== 'all' && l.level !== lvl) return false;
    if (sid && l.scriptId !== sid) return false;
    if (q && ![l.message, l.url, l.stack, l.scriptName, l.kind].join('\n').toLowerCase().includes(q)) return false;
    return true;
  });
}

function renderLogScriptFilter() {
  const sel = $('#log-script');
  const cur = sel.value;
  sel.replaceChildren(h('option', { value: '' }, 'All scripts'), ...state.scripts.map((s) => h('option', { value: s.id }, s.name)));
  sel.value = cur;
}

function renderLogs() {
  renderLogScriptFilter();
  const logs = filteredLogs();
  const box = $('#log-list');
  if (!logs.length) {
    box.replaceChildren(h('div', { class: 'empty-logs' }, state.logs.length ? 'No log entries match the filter.' : 'No logs yet. Errors and captured console output show up here.'));
    return;
  }
  const focus = params.get('log');
  box.replaceChildren(...logs.slice(0, 1000).map((l) => {
    const script = state.scripts.find((s) => s.id === l.scriptId);
    const levelText = l.level === 'console' ? 'console.' + (l.consoleLevel || 'log') : l.level;
    const pillCls = l.level === 'error' ? 'err' : l.level === 'warn' ? 'warn' : l.consoleLevel === 'error' ? 'err' : l.consoleLevel === 'warn' ? 'warn' : 'accent';
    const el = h('div', { class: `log ${l.level}${l.id === focus ? ' open flash' : ''}`, onclick: (e) => { if (!e.target.closest('button, a, pre, dd')) el.classList.toggle('open'); } },
      h('div', { class: 'log-head' },
        h('span', { class: 'pill ' + pillCls }, levelText),
        h('b', {}, l.scriptName || 'Extension'),
        l.kind ? h('span', { class: 'muted' }, l.kind) : null,
        l.line ? h('span', { class: 'muted mono' }, `line ${l.line}${l.col ? ':' + l.col : ''}`) : null,
        l.isFrame ? h('span', { class: 'pill' }, 'iframe') : null,
        h('span', { class: 'grow' }),
        l.url ? h('span', { class: 'muted ellipsis', style: { maxWidth: '280px' }, title: l.url }, store.hostOf(l.url) || l.url) : null,
        h('span', { class: 'muted', title: new Date(l.time).toLocaleString() }, timeAgo(l.time))
      ),
      h('div', { class: 'log-msg' }, l.message),
      h('div', { class: 'log-detail' },
        h('dl', {},
          h('dt', {}, 'Time'), h('dd', {}, new Date(l.time).toLocaleString()),
          l.url ? [h('dt', {}, 'URL'), h('dd', {}, l.url)] : null,
          l.trigger ? [h('dt', {}, 'Trigger'), h('dd', {}, l.trigger)] : null,
          l.tabId != null ? [h('dt', {}, 'Tab / frame'), h('dd', {}, `${l.tabId} / ${l.frameId ?? 0}`)] : null,
          h('dt', {}, 'Source'), h('dd', {}, l.source || '')
        ),
        l.stack ? h('pre', {}, l.stack) : null,
        h('div', { class: 'row', style: { marginTop: '8px' } },
          script ? h('button', { class: 'small', onclick: () => { setView('scripts'); selectScript(script.id); if (l.line) setTimeout(() => editor.goTo(l.line), 50); } }, l.line ? `Open script at line ${l.line}` : 'Open script') : null,
          h('button', { class: 'small', onclick: () => { navigator.clipboard.writeText(JSON.stringify(l, null, 2)); toast('Copied'); } }, 'Copy JSON')
        )
      )
    );
    return el;
  }));
  if (focus) {
    const el = box.querySelector('.flash');
    if (el) el.scrollIntoView({ block: 'center' });
    params.delete('log');
  }
}

['#log-level', '#log-script', '#log-search'].forEach((id) => $(id).addEventListener('input', renderLogs));
$('#btn-clear-logs').addEventListener('click', async () => {
  const sid = $('#log-script').value;
  const lvl = $('#log-level').value;
  const filtered = sid || lvl !== 'all' || $('#log-search').value.trim();
  if (!confirm(filtered ? 'Clear the log entries matching the current filter?' : 'Clear all logs?')) return;
  if (filtered) {
    const ids = new Set(filteredLogs().map((l) => l.id));
    await store.clearLogs((l) => ids.has(l.id));
  } else {
    await store.clearLogs();
    await chrome.storage.local.set({ stats: Object.fromEntries(Object.entries(state.stats).map(([k, v]) => [k, { ...v, errors: 0 }])) });
  }
});
$('#btn-export-logs').addEventListener('click', () => {
  download(`script-injector-logs-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`, JSON.stringify(filteredLogs(), null, 2));
});

/* =====================================================================
 * Pattern tester
 * =================================================================== */

function renderTester() {
  const url = $('#t-url').value.trim();
  const tbody = $('#t-table tbody');
  if (!url) {
    tbody.replaceChildren(h('tr', {}, h('td', { colspan: 5, class: 'muted' }, 'Enter a URL to see which scripts would run.')));
  } else {
    const paused = state.settings.disabledHosts.includes(store.hostOf(url));
    tbody.replaceChildren(...state.scripts.map((s) => {
      const r = siMatch(url, s.include, s.exclude, true);
      let status;
      if (s.runAt === 'manual') status = h('span', { class: 'pill' }, 'manual');
      else if (!r.matched) status = h('span', { class: 'pill err' }, r.include ? 'excluded' : 'no match');
      else if (!s.enabled) status = h('span', { class: 'pill' }, 'matches (disabled)');
      else if (!state.settings.enabled) status = h('span', { class: 'pill warn' }, 'matches (injector off)');
      else if (paused) status = h('span', { class: 'pill warn' }, 'matches (site paused)');
      else status = h('span', { class: 'pill ok' }, '✓ will run');
      return h('tr', {},
        h('td', {}, h('b', {}, s.name), h('div', { class: 'muted' }, `${s.type.toUpperCase()} · ${s.runAt}`)),
        h('td', {}, status, r.errors.length ? h('div', { class: 'pill err', title: r.errors.join('\n') }, '⚠ pattern error') : null),
        h('td', {}, r.include ? h('code', {}, r.include) : h('span', { class: 'muted' }, '—')),
        h('td', {}, r.exclude ? h('code', {}, r.exclude) : h('span', { class: 'muted' }, '—')),
        h('td', {}, h('button', { class: 'small', onclick: () => { setView('scripts'); selectScript(s.id); } }, 'Edit'))
      );
    }));
  }
  renderScratch();
}

function renderScratch() {
  const url = $('#t-url').value.trim();
  const inc = store.toList($('#t-inc').value);
  const exc = store.toList($('#t-exc').value);
  const out = $('#t-scratch-result');
  if (!url) return out.replaceChildren(h('div', { class: 'muted' }, 'Enter a URL above.'));
  const rows = [...inc.map((p) => ['include', p]), ...exc.map((p) => ['exclude', p])].map(([kind, p]) => {
    const err = validatePattern(p);
    const hit = !err && siMatch(url, [p], [], false);
    return h('div', { class: 'row' },
      h('span', { class: 'pill' }, kind),
      h('code', { class: 'grow' }, p),
      h('span', { class: 'muted' }, patternKind(p)),
      err ? h('span', { class: 'pill err', title: err }, 'invalid') : h('span', { class: 'pill ' + (hit ? 'ok' : '') }, hit ? 'matches' : 'no match')
    );
  });
  const final = siMatch(url, inc, exc);
  out.replaceChildren(...rows, h('div', { class: 'row' }, h('b', { class: 'grow' }, 'Result'), h('span', { class: 'pill ' + (final ? 'ok' : 'err') }, final ? '✓ would run' : '✗ would not run')));
}

$('#t-url').addEventListener('input', renderTester);
$('#t-inc').addEventListener('input', renderScratch);
$('#t-exc').addEventListener('input', renderScratch);
$('#t-use-tab').addEventListener('click', async () => {
  const t = await targetTab();
  if (!t) return toast('No web tab open', 'err');
  $('#t-url').value = t.url;
  renderTester();
});

/* =====================================================================
 * Settings
 * =================================================================== */

function renderSettings() {
  const s = state.settings;
  $('#s-autoReinject').checked = s.autoReinjectOnSave;
  $('#s-notify').checked = s.notifyOnError;
  $('#s-badge').checked = s.showBadge;
  $('#s-statusStyle').value = s.statusStyle || (s.statusPill === false ? 'off' : 'auto');
  $('#s-logConsole').checked = s.logConsole;
  $('#s-maxLogs').value = s.maxLogs;
  $('#s-autoUpdate').checked = s.autoUpdate !== false;
  $('#s-updateHours').value = String(s.updateHours || 6);
  $('#s-extCheckHours').value = String(Number.isFinite(+s.extCheckHours) ? +s.extCheckHours : 6);
  $('#s-extAutoApply').checked = s.extAutoApply !== false;
  $('#s-extDevTest').checked = !!s.extDevTest;
  fetch(chrome.runtime.getURL('install.json'), { cache: 'no-store' }).then((r) => r.ok).catch(() => false).then((installed) => {
    $('#s-ext-mode').textContent = installed ? 'This copy was installed by the setup: updates apply automatically.' : 'This copy is a developer copy (loaded from a folder): updates are never applied automatically.';
    $('#s-extDevTest-wrap').hidden = installed;
  });
  renderUpdateStatus();
  if (document.activeElement !== $('#s-hosts')) $('#s-hosts').value = s.disabledHosts.join('\n');

  const e = state.engine;
  const card = $('#engine-card');
  if (!e) {
    card.replaceChildren(h('h3', {}, 'Injection engine'), h('p', { class: 'muted' }, 'Unknown'));
  } else if (e.userScripts) {
    card.replaceChildren(
      h('h3', {}, 'Injection engine ', h('span', { class: 'pill ok' }, 'User Scripts ✓')),
      h('p', {}, `Chrome ${e.chromeVersion}. Scripts are registered with chrome.userScripts: page CSP is bypassed, timing is exact, and both Page and Isolated worlds work.`),
      e.execute ? null : h('p', { class: 'muted' }, 'Instant reinject (chrome.userScripts.execute) needs Chrome 135+. Reinject uses script tags until then.'),
      h('div', { class: 'row' }, h('button', { onclick: resync }, 'Re-register scripts'))
    );
  } else {
    card.replaceChildren(
      h('h3', {}, 'Injection engine ', h('span', { class: 'pill warn' }, 'Limited mode')),
      h('p', {}, 'The chrome.userScripts API is turned off, so scripts are injected as <script> tags. Pages with a strict Content-Security-Policy (GitHub, many banking and Google sites) will block them, and the failure appears in Logs.'),
      h('ol', {},
        h('li', {}, 'Open the extension details page (button below).'),
        h('li', {}, 'Chrome 138+: turn on ', h('b', {}, 'Allow User Scripts'), '. Older Chrome: turn on ', h('b', {}, 'Developer mode'), ' (top-right of chrome://extensions).'),
        h('li', {}, 'Come back and click ', h('b', {}, 'Re-check'), '.')
      ),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: () => send('openUserScriptsSettings') }, 'Open extension settings'),
        h('button', { onclick: resync }, 'Re-check')
      )
    );
  }
  chrome.storage.local.getBytesInUse(null).then((b) => {
    $('#s-usage').textContent = `Storage used: ${(b / 1024).toFixed(1)} KB · ${state.scripts.length} scripts · ${state.logs.length} log entries`;
  });
}

async function resync() {
  try {
    const r = await send('resync');
    state.engine = r.engine;
    renderEngine();
    toast(r.engine.userScripts ? `Registered ${r.registered} script(s)` : 'Still in limited mode. User Scripts is off.', r.engine.userScripts ? 'ok' : 'err');
  } catch (e) {
    toast(e.message, 'err');
  }
}

const bindSetting = (id, key, read = (el) => el.checked) => $(id).addEventListener('change', async (e) => {
  state.settings = await store.saveSettings({ [key]: read(e.target) });
  toast('Settings saved', 'ok');
});
bindSetting('#s-autoReinject', 'autoReinjectOnSave');
bindSetting('#s-notify', 'notifyOnError');
bindSetting('#s-badge', 'showBadge');
bindSetting('#s-autoUpdate', 'autoUpdate');
bindSetting('#s-updateHours', 'updateHours', (el) => parseInt(el.value, 10) || 6);
bindSetting('#s-extCheckHours', 'extCheckHours', (el) => { const v = parseInt(el.value, 10); return Number.isFinite(v) ? v : 6; });
bindSetting('#s-extAutoApply', 'extAutoApply');
bindSetting('#s-extDevTest', 'extDevTest');
$('#s-ext-test').addEventListener('click', async () => {
  const out = $('#s-ext-test-status');
  out.textContent = 'Checking…';
  try {
    const r = await send('extUpdateCheck');
    const st = r.state || {}, d = r.disk || {};
    if (d.pending) { out.textContent = `v${d.version} is on disk: applying (the extension reloads)…`; await send('extApplyNow'); }
    else out.textContent = st.error ? 'GitHub check failed: ' + st.error : `Running v${st.current}. GitHub has v${st.latest || '?'}${st.latest && st.latest !== st.current ? ' (download it with the updater)' : ' (up to date)'}.`;
  } catch (e) { out.textContent = e.message; }
});
bindSetting('#s-statusStyle', 'statusStyle', (el) => el.value);
bindSetting('#s-logConsole', 'logConsole');
bindSetting('#s-maxLogs', 'maxLogs', (el) => Math.max(50, Math.min(10000, parseInt(el.value, 10) || 500)));

$('#s-save-hosts').addEventListener('click', async () => {
  const hosts = [...new Set(store.toList($('#s-hosts').value).map((x) => x.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase()))];
  state.settings = await store.saveSettings({ disabledHosts: hosts });
  $('#s-hosts').value = hosts.join('\n');
  toast('Paused sites saved', 'ok');
});
$('#s-export').addEventListener('click', () => {
  download(`script-injector-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ format: 'script-injector', version: 1, exportedAt: new Date().toISOString(), settings: state.settings, scripts: state.scripts }, null, 2));
});
$('#s-import').addEventListener('click', () => {
  importContext = 'settings';
  $('#file-input').click();
});
$('#s-resync').addEventListener('click', resync);
$('#s-shortcuts').addEventListener('click', () => send('openUrl', { url: 'chrome://extensions/shortcuts' }));
$('#s-reset').addEventListener('click', async () => {
  if (!confirm('Delete ALL scripts, logs and settings and restore the examples? This cannot be undone.')) return;
  await chrome.storage.local.clear();
  await store.setScripts(store.sampleScripts());
  await store.saveSettings({});
  state.draft = null;
  state.currentId = null;
  await loadData();
  renderAll();
  toast('Reset complete');
});

/* =====================================================================
 * Global
 * =================================================================== */

$('#global-toggle').addEventListener('change', async (e) => {
  state.settings = await store.saveSettings({ enabled: e.target.checked });
  renderHeader();
  toast(e.target.checked ? 'Injection on' : 'Injection off');
});
$$('#tabs button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
$('#top-data').addEventListener('click', () => setView('data'));
$('#btn-new').addEventListener('click', () => newScript());
$('#btn-new-2').addEventListener('click', () => newScript());
$('#search').addEventListener('input', renderList);
$('#filter').addEventListener('input', renderList);

function renderAll() {
  renderHeader();
  renderList();
  const s = currentScript();
  $('#empty-editor').classList.toggle('hidden', !!s);
  $('#editor').classList.toggle('hidden', !s);
  if (state.view === 'logs') renderLogs();
  if (state.view === 'tester') renderTester();
  if (state.view === 'settings') renderSettings();
}

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  if (!['scripts', 'settings', 'stats', 'logs', 'updates'].some((k) => changes[k])) return;
  if (changes.updates) { state.updates = changes.updates.newValue || {}; renderUpdRow(); renderUpdateStatus(); }
  await loadData();
  renderHeader();
  renderList();
  if (changes.scripts && state.currentId && !(state.draft && state.draft.id === state.currentId)) {
    const fresh = state.scripts.find((s) => s.id === state.currentId);
    if (!fresh) {
      if (!isDirty()) selectScript(null, { force: true });
    } else if (state.loaded && fresh.updatedAt !== state.loaded.updatedAt) {
      if (!isDirty()) {
        state.loaded = fresh;
        fillForm(fresh);
      } else {
        // Keep the user's edits; only sync the enabled toggle baseline.
        state.loaded = { ...state.loaded, enabled: fresh.enabled, updatedAt: fresh.updatedAt };
        F.enabled.checked = fresh.enabled;
        updateDirty();
      }
    }
  }
  if (changes.stats) renderStats();
  if (state.view === 'logs' && changes.logs) renderLogs();
  if (state.view === 'tester') renderTester();
  if (state.view === 'settings' && changes.settings) renderSettings();
});

async function init() {
  await loadData();
  renderHeader();
  renderList();
  loadEngine();

  const tab = await targetTab();
  if (tab) {
    $('#f-test-url').value = tab.url;
    $('#t-url').value = tab.url;
  }

  const view = params.get('view') || 'scripts';
  const edit = params.get('edit');
  const nw = params.get('new');
  if (nw !== null) {
    newScript(nw ? { name: `New script for ${nw}`, include: [`*://${nw}/*`] } : {});
  } else if (edit && state.scripts.some((s) => s.id === edit)) {
    selectScript(edit, { force: true });
    setView('scripts', false);
  } else {
    setView(view, false);
    if (view === 'scripts' && state.scripts.length) selectScript(state.scripts[0].id, { force: true });
  }
  if (params.get('welcome')) {
    toast('Welcome! Turn on “Allow User Scripts” for full CSP-proof injection.');
  }
}

init();

/* =====================================================================
 * Versions, install from link / files, updates
 * =================================================================== */

// @version in the code's header wins (so bumping it in the editor and saving publishes the new number)
function headerVersion(code, fallback) {
  if (!/==UserScript==/.test(code)) return fallback || 0;
  const v = store.parseUserScript(code).version;
  return v || fallback || 0;
}

function renderUpdRow(s = currentScript()) {
  const row = $('#upd-row');
  if (!s) return;
  const v = hideCode ? s.version : headerVersion(F.code.value || s.code, s.version);
  $('#f-version').textContent = v ? 'v' + v : 'no version';
  $('#f-version').classList.toggle('muted', !v);
  const u = state.updates[s.id];
  const st = $('#upd-status');
  st.className = 'muted';
  if (!s.sourceUrl) st.textContent = '';
  else if (!u) st.textContent = 'Not checked yet';
  else if (u.error) { st.textContent = '⚠ ' + u.error; st.className = 'err-text'; }
  else if (u.latest > s.version) { st.textContent = `v${u.latest} available` + (u.edited ? ' (you edited this script: Check now replaces your edits)' : ''); st.className = 'upd-badge'; }
  else st.textContent = `Up to date · checked ${timeAgo(u.checkedAt)}`;
  $('#btn-check-update').disabled = !s.sourceUrl || (state.draft && state.draft.id === s.id);
  row.classList.remove('hidden');
}

$('#btn-check-update').addEventListener('click', async () => {
  const s = currentScript();
  if (!s || !s.sourceUrl) return;
  if (isDirty()) return toast('Save your changes first', 'err');
  const u = state.updates[s.id];
  const overwriteEdits = installer.isEdited(s) && (!u || !u.latest || u.latest > s.version)
    ? confirm('You edited this script. If a newer version exists, installing it replaces your edits.\n\nOK = check and update · Cancel = only check')
    : false;
  $('#upd-status').textContent = 'Checking…';
  try {
    const r = await installer.checkUpdates({ ids: [s.id], overwriteEdits });
    await loadData();
    renderAll();
    toast(r.updated.length ? 'Updated: ' + r.updated.map((x) => `${x.name} v${x.from} → v${x.to}`).join(', ') : 'No update installed', r.updated.length ? 'ok' : 'info');
  } catch (e) {
    toast('Check failed: ' + e.message, 'err');
  }
  renderUpdRow();
});
F.code.addEventListener('input', () => renderUpdRow());

function renderUpdateStatus() {
  const el = $('#s-update-status');
  if (!el) return;
  const last = state.updates._last;
  const linked = state.scripts.filter((s) => s.sourceUrl).length;
  const avail = state.scripts.filter((s) => { const u = state.updates[s.id]; return u && u.latest > s.version; });
  el.textContent = `${linked} script(s) with an update link` + (last ? ` · last check ${timeAgo(last.at)}${last.updated.length ? ` (updated ${last.updated.length})` : ''}` : '') + (avail.length ? ` · ${avail.length} update(s) waiting: ${avail.map((s) => s.name).join(', ')}` : '');
}

$('#s-check-updates').addEventListener('click', async (e) => {
  e.target.disabled = true;
  $('#s-update-status').textContent = 'Checking…';
  try {
    const r = await installer.checkUpdates();
    await loadData();
    renderAll();
    const errs = Object.entries(r.state).filter(([k, v]) => k !== '_last' && v.error).length;
    toast(r.updated.length ? 'Updated: ' + r.updated.map((x) => `${x.name} v${x.from} → v${x.to}`).join(', ') : `Checked ${r.checked}: no updates` + (errs ? ` (${errs} failed)` : ''), errs ? 'err' : 'ok');
  } catch (err) {
    toast('Check failed: ' + err.message, 'err');
  }
  e.target.disabled = false;
  renderUpdateStatus();
});

// ---- install dialog ----
const dlg = $('#install-dlg');
let planRows = [];

function openInstall(items = null) {
  $('#inst-source').classList.toggle('hidden', !!items);
  $('#inst-plan').classList.add('hidden');
  $('#inst-plan').replaceChildren();
  if (!dlg.open) dlg.showModal();
  if (items) showPlan(items);
  else $('#inst-urls').focus();
}
dlg.addEventListener('click', (e) => { if (e.target.closest('[data-close]') || e.target === dlg) dlg.close(); });
$('#btn-install-url').addEventListener('click', () => openInstall());
$('#inst-load').addEventListener('click', async () => {
  const urls = store.toList($('#inst-urls').value);
  if (!urls.length) return toast('Paste a link first', 'err');
  const bad = urls.filter((u) => !/^https?:\/\//i.test(u));
  if (bad.length) return toast('Links must start with https://', 'err');
  // token for private repos: saved per repo (only github.com / API links), never sent elsewhere
  const tok = $('#inst-token').value.trim();
  if (tok) {
    const repos = [...new Set(urls.map(gh.repoOf).filter(Boolean))];
    if (!repos.length) return toast('A token only works with github.com links (e.g. github.com/owner/repo/tree/main/folder)', 'err');
    for (const r of repos) await gh.saveRepoToken(r, tok);
    $('#inst-token').value = '';
    renderRepoTokens();
  }
  $('#inst-load').disabled = true;
  $('#inst-load').textContent = 'Loading…';
  try {
    showPlan(await installer.loadSources(urls));
  } finally {
    $('#inst-load').disabled = false;
    $('#inst-load').textContent = 'Load';
  }
});

const STATUS = {
  new: ['New', 'ok'],
  update: ['Update', 'accent'],
  same: ['Installed', ''],
  older: ['Older than installed', 'warn'],
  error: ['Failed', 'err']
};

function showPlan(items) {
  planRows = installer.plan(items, state.scripts).map((r) => ({ ...r, on: r.status === 'new' || r.status === 'update' }));
  // pick the required scripts of what is picked, when they are new / updated in this list
  for (const r of planRows) if (r.on) for (const d of r.deps) { const dep = planRows.find((x) => x.script && x.script.id === d.id); if (dep && dep.status !== 'error' && !dep.cur) dep.on = true; }
  $('#inst-plan').classList.remove('hidden');
  renderPlan();
}

function renderPlan() {
  const sel = new Set(planRows.filter((r) => r.on && r.script).map((r) => r.script.id));
  const installedIds = new Set(state.scripts.map((s) => s.id));
  let blocked = 0;
  const rows = planRows.map((r, i) => {
    const b = r.on || r.status === 'error' ? installer.blockers(r, sel, installedIds) : [];
    if (r.on && b.length) blocked++;
    const s = r.script;
    const [label, cls] = STATUS[r.status];
    const ver = !s ? '' : r.status === 'update' ? `v${r.cur.version || 0} → v${s.version}` : r.status === 'older' ? `v${s.version} (have v${r.cur.version})` : s.version ? 'v' + s.version : 'no version';
    const warn = r.problems.filter((p) => !b.includes(p));
    return h('tr', { class: r.on ? '' : 'off' },
      h('td', {}, h('input', { type: 'checkbox', checked: r.on, disabled: r.status === 'error', onchange: (e) => {
        r.on = e.target.checked;
        if (r.on) for (const d of r.deps) { const dep = planRows.find((x) => x.script && x.script.id === d.id); if (dep && dep.status !== 'error' && !dep.cur) dep.on = true; }
        renderPlan();
      } })),
      h('td', {},
        h('div', { class: 'inst-name' }, s ? s.name : r.name),
        s && s.description ? h('div', { class: 'muted inst-desc' }, s.description) : null,
        h('div', { class: 'muted inst-src ellipsis', title: r.url || r.local || '' }, r.url || r.local || 'local file')
      ),
      h('td', {}, h('span', { class: 'pill ' + cls }, label), h('div', { class: 'inst-ver' }, ver)),
      h('td', {}, r.deps.length ? r.deps.map((d) => {
        const have = installedIds.has(d.id);
        const ok = have || (d.where === 'batch' && sel.has(d.id));
        return h('div', { class: ok ? 'muted' : 'err-text' }, (ok ? '✓ ' : '✕ ') + d.name + (have ? ' (installed)' : d.where === 'batch' ? ' (in this list)' : ' (missing)'));
      }) : h('span', { class: 'muted' }, 'none')),
      h('td', {}, b.map((x) => h('div', { class: 'err-text' }, '✕ ' + x)), warn.map((x) => h('div', { class: 'warn-text' }, '⚠ ' + x)))
    );
  });
  const n = sel.size;
  $('#inst-plan').replaceChildren(
    h('table', { class: 'inst-table' },
      h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Script'), h('th', {}, 'Version'), h('th', {}, 'Requires'), h('th', {}, 'Checks'))),
      h('tbody', {}, rows)),
    h('div', { class: 'row', style: { marginTop: '10px' } },
      h('span', { class: 'muted grow' }, blocked ? `Fix ${blocked} problem(s) marked ✕ (or untick them) to install.` : n ? 'Your on/off choices are kept for updated scripts. New scripts are turned on with what they require.' : 'Nothing selected.'),
      h('button', { type: 'button', onclick: () => openInstall() }, 'Back'),
      h('button', { type: 'button', class: 'primary', disabled: !n || blocked > 0, onclick: doInstall }, `Install ${n || ''}`.trim()))
  );
}

async function doInstall() {
  const rows = planRows.filter((r) => r.on && r.script);
  try {
    const r = await installer.install(rows);
    const names = [...new Set(rows.map((x) => x.script.origin || '').filter((o) => o.startsWith('folder:')).map((o) => o.slice(7)))];
    if (names.length) { const lf = (await chrome.storage.local.get('localFolders')).localFolders || []; await chrome.storage.local.set({ localFolders: [...new Set([...lf, ...names])] }); }
    await loadData();
    renderAll();
    dlg.close();
    toast(`Installed ${r.added} new, updated ${r.updated}`, 'ok');
  } catch (e) {
    toast('Install failed: ' + e.message, 'err');
  }
}

// ---- admin control (private repo control.json) ----
{
  const slot = h('div', { class: 'si-ctl-slot' });
  document.querySelector('header.topbar').after(slot);
  setupLock({
    host: slot,
    lockSel: '#global-toggle, #btn-new, #btn-new-2, #btn-export-all, #btn-export-one, #s-export, #editor input, #editor select, #editor textarea, #btn-refresh-requires, #btn-delete, #btn-duplicate, #btn-revert, #btn-save-reinject, #btn-save, #view-settings input, #view-settings select, #view-settings textarea, #view-settings button:not(#s-export), #view-data button:not(#d-refresh), #view-data input, #view-data textarea, #view-data select',
    toggleSel: '.script-list input',
    importSel: '#btn-install-url, #btn-import, #install-dlg button, #install-dlg textarea, #file-input, #inst-file-input, #inst-folder-input'
  });
  renderControlCard();
  chrome.storage.onChanged.addListener((c, a) => { if (a === 'local' && c.control) renderControlCard(); });
}
async function renderControlCard() {
  const card = $('#control-card');
  if (!(await control.isManaged())) return card.classList.add('hidden');
  const [st, info, block] = await Promise.all([control.getState(), control.lockInfo(), control.blocked()]);
  const cfg = (st && st.cfg) || {};
  card.classList.remove('hidden');
  card.replaceChildren(
    h('h3', {}, 'Admin control ', h('span', { class: 'pill ' + (block ? 'err' : 'ok') }, block ? 'Stopped' : 'Active')),
    h('p', { class: 'muted' }, 'This copy is managed from the admin\'s private repo (control.json). Scripts run from the local copy; settings are checked every ' + (cfg.checkMinutes || 15) + ' min.'),
    block ? h('p', { class: 'err-text' }, block.reason) : null,
    h('div', { class: 'muted' }, 'Last successful check: ' + (st && st.lastOkAt ? timeAgo(st.lastOkAt) : 'never') + (st && st.error ? ' · last error: ' + st.error : '')),
    h('div', { class: 'muted' }, 'Editing: ' + (!info ? 'not locked' : info.locked ? 'locked (password needed)' : 'unlocked for now')),
    await renderLibraries(cfg, info),
    h('div', { class: 'row', style: { marginTop: '8px' } }, h('button', { 'data-lockfree': true, onclick: async (e) => { e.target.disabled = true; const r = await control.check(); toast(r.error ? 'Check failed: ' + r.error : 'Checked', r.error ? 'err' : 'ok'); e.target.disabled = false; } }, 'Check now'))
  );
}

// Libraries this copy installs from: team / public ones (always), private ones (with the admin key on this PC)
async function renderLibraries(cfg, info) {
  const g = await gh.ghConfig();
  const count = (prefix) => state.scripts.filter((s) => s.sourceUrl.startsWith(prefix)).length;
  const label = (url) => gh.repoOf(url) || url;
  const team = (Array.isArray(cfg.library) ? cfg.library : cfg.library ? [cfg.library] : []).map((e) => (typeof e === 'string' ? e : e.url));
  if (!team.length && g) team.push(g.defaultLibrary);
  const priv = (Array.isArray(cfg.privateLibrary) ? cfg.privateLibrary : cfg.privateLibrary ? [cfg.privateLibrary] : []).filter((p) => p && p.repo);
  const rows = team.map((u) => h('div', { class: 'lib-row' },
    h('span', { class: 'grow lib-name' }, icon('github'), label(u), h('span', { class: 'grp-tag' }, 'GitHub · team')),
    h('span', { class: 'pill ok' }, `✓ connected · ${count(u)} script(s)`)));
  for (const p of priv) {
    const root = `https://api.github.com/repos/${p.repo}/contents/`;
    const on = !!((await gh.repoTokens())[root] || ((await gh.privateAccess()) || { tokens: {} }).tokens[root]);
    const input = h('input', { type: 'password', placeholder: 'Read-only token for this repo', autocomplete: 'off', 'data-lockfree': true, style: { width: '240px' } });
    const msg = h('span', { class: 'err-text' });
    rows.push(h('div', { class: 'lib-row' },
      h('span', { class: 'grow lib-name' }, icon('lock'), p.repo, h('span', { class: 'grp-tag' }, 'GitHub · private')),
      on
        ? h('span', { class: 'pill accent' }, `✓ unlocked on this PC · ${count(root)} script(s)`)
        : h('form', { class: 'row', onsubmit: async (e) => {
          e.preventDefault();
          await connectPrivate(p, input.value, msg);
        } }, input, h('button', { type: 'submit', class: 'small primary', 'data-lockfree': true }, 'Connect'), msg)));
  }
  return h('div', { class: 'libs' }, h('h4', {}, 'Libraries'), ...rows);
}

// ---- install from this computer: files, a folder (with subfolders), or drag & drop anywhere ----
const SKIP_DIR = /(^|\/)(node_modules|\.git)(\/|$)/;
async function itemsFromFiles(files) {
  const js = files.filter((f) => /\.js$/i.test(f.name) && !SKIP_DIR.test(f.path || f.webkitRelativePath || ''));
  if (!js.length) { toast('No .js files found', 'err'); return null; }
  return Promise.all(js.map(async (f) => {
    const rel = f.path || f.webkitRelativePath || '';
    const it = installer.fromCode(await f.text(), '', f.name);
    // installed from a folder → remember its top folder so the list keeps those scripts together
    if (rel.includes('/')) it.script.origin = 'folder:' + rel.split('/')[0];
    return { ...it, local: rel || f.name };
  }));
}
// Dropped folders: walk them (readEntries returns at most 100 entries per call)
async function filesFromDrop(dt) {
  const out = [];
  const walk = async (entry, prefix) => {
    if (!entry || SKIP_DIR.test(prefix + entry.name)) return;
    if (entry.isFile) {
      const f = await new Promise((res, rej) => entry.file(res, rej));
      f.path = prefix + entry.name;
      out.push(f);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e, prefix + entry.name + '/');
      }
    }
  };
  const entries = [...dt.items].map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
  if (entries.some(Boolean)) for (const e of entries) await walk(e, '');
  else out.push(...dt.files);
  return out;
}
async function installLocal(files) {
  const items = await itemsFromFiles(files);
  if (items) openInstall(items);
}
$('#inst-files').addEventListener('click', () => $('#inst-file-input').click());
$('#inst-folder').addEventListener('click', () => $('#inst-folder-input').click());
for (const id of ['#inst-file-input', '#inst-folder-input']) {
  $(id).addEventListener('change', async (e) => { const f = [...e.target.files]; e.target.value = ''; if (f.length) await installLocal(f); });
}
// Drop on the dialog or anywhere on the Scripts page
const hasFiles = (e) => [...(e.dataTransfer && e.dataTransfer.types || [])].includes('Files');
let dragDepth = 0;
document.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; document.body.classList.add('si-dragging'); } });
document.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('si-dragging'); } });
document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
document.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('si-dragging');
  if (state.view !== 'scripts' && !dlg.open) return;
  if ($('#btn-install-url').disabled) return toast('Locked by your admin', 'err');
  await installLocal(await filesFromDrop(e.dataTransfer));
});

// ---- saved tokens for other private repos ----
async function renderRepoTokens() {
  const box = $('#s-repo-tokens');
  if (!box) return;
  const t = await gh.repoTokens();
  const keys = Object.keys(t);
  box.replaceChildren(...(keys.length ? keys.map((base) => {
    const repo = gh.repoOf(base) || base;
    return h('div', { class: 'row', style: { margin: '4px 0' } },
      h('span', { class: 'grow lib-name' }, icon('key'), repo, h('span', { class: 'muted' }, ' · ' + state.scripts.filter((s) => s.sourceUrl.startsWith(base)).length + ' script(s)')),
      h('button', { class: 'small danger', onclick: async () => { if (confirm('Remove the token for ' + repo + '? Its scripts stay installed but stop updating.')) { await gh.saveRepoToken(repo, ''); renderRepoTokens(); } } }, 'Remove'));
  }) : [h('div', { class: 'muted' }, 'None yet. Add one in Install → Access token.')]));
}
renderRepoTokens();

// ---- private libraries waiting for their token (shown at the top of the script list) ----
function privateLibsOf(cfg) {
  const l = cfg && cfg.privateLibrary;
  return (Array.isArray(l) ? l : l ? [l] : []).filter((x) => x && x.repo);
}
async function connectPrivate(p, token, msg) {
  const tok = String(token || '').trim();
  if (!tok) return;
  const root = 'https://api.github.com/repos/' + p.repo + '/contents/';
  msg.textContent = 'Checking…';
  // test the token on this repo before saving it
  const r = await fetch(root + (p.path && p.path !== '/' ? p.path.replace(/^\//, '') : '') + 'index.json', { headers: { Authorization: 'Bearer ' + tok, Accept: 'application/vnd.github.raw' }, cache: 'no-store' }).catch(() => null);
  if (!r || !r.ok) { msg.textContent = r ? (r.status === 401 ? 'Token not accepted' : 'This token cannot read ' + p.repo + ' (needs Contents: Read-only)') : 'No connection'; return; }
  await gh.saveRepoToken(p.repo, tok);
  msg.textContent = 'Connected, installing…';
  toast('Connected: installing ' + p.repo + '…', 'ok');
  await control.check();
  location.reload();
}
var pendingLibs = []; // var: renderList may run before this line is reached
async function refreshPendingLibs() {
  const pend = [];
  const known = [];
  const add = (src) => { if (!known.some((k) => k.key === src.key)) known.push(src); };
  const repoSrc = (repo, note) => ({ key: 'repo:' + repo, kind: 'repo', icon: /private|token/.test(note) ? 'lock' : 'github', tag: /for everyone/.test(note) ? 'GitHub · team' : /private|token/.test(note) ? 'GitHub · private' : 'GitHub', label: repo.split('/')[1], title: 'GitHub repo ' + repo, note });
  const [rt, pa] = await Promise.all([gh.repoTokens(), gh.privateAccess()]);
  if (await control.isManaged()) {
    const st = await control.getState();
    const cfg = (st && st.cfg) || {};
    const g = await gh.ghConfig();
    const team = (Array.isArray(cfg.library) ? cfg.library : cfg.library ? [cfg.library] : []).map((e) => (typeof e === 'string' ? e : e.url));
    if (!team.length && g) team.push(g.defaultLibrary);
    for (const u of team) { const r = gh.repoOf(u); add(r ? repoSrc(r, 'connected · for everyone') : { key: 'dir:' + u, kind: 'folder', icon: 'folder', tag: 'Web folder · team', label: u, title: u, note: 'connected · for everyone' }); }
    for (const p of privateLibsOf(cfg)) {
      const root = 'https://api.github.com/repos/' + p.repo + '/contents/';
      if (rt[root] || (pa && pa.tokens && pa.tokens[root])) add(repoSrc(p.repo, 'connected · private'));
      else pend.push(p);
    }
  }
  for (const root of Object.keys(rt)) { const r = gh.repoOf(root); if (r) add(repoSrc(r, 'connected with its token')); }
  for (const n of (await chrome.storage.local.get('localFolders')).localFolders || []) add({ key: 'local:' + n, kind: 'localdir', icon: 'folderOpen', tag: 'Local folder', label: n, title: 'Folder "' + n + '" on this computer', note: 'local folder' });
  pendingLibs = pend;
  knownSources = known;
}
var knownSources = []; // sources always listed: connected repos + local folders
function pendingLibRows() {
  return pendingLibs.map((p) => {
    const msg = h('span', { class: 'err-text' });
    const input = h('input', { type: 'password', placeholder: 'Read-only token for this repo', autocomplete: 'off', 'data-lockfree': true });
    const form = h('form', { class: 'pend-form hidden', onsubmit: async (e) => { e.preventDefault(); await connectPrivate(p, input.value, msg); } },
      input, h('button', { type: 'submit', class: 'small primary', 'data-lockfree': true }, 'Connect'), msg);
    return h('li', { class: 'pend-lib', onclick: (e) => e.stopPropagation() },
      h('div', { class: 'row' },
        h('span', { class: 'grow ellipsis', title: 'Private repo: connect it with its read-only token to install its scripts' }, h('span', { class: 'lib-name' }, icon('lock'), p.repo, h('span', { class: 'grp-tag' }, 'GitHub · private')), h('div', { class: 's-meta' }, 'not connected on this PC')),
        h('button', { type: 'button', class: 'small primary', 'data-lockfree': true, onclick: () => { form.classList.toggle('hidden'); input.focus(); } }, 'Connect')),
      form);
  });
}
refreshPendingLibs().then(() => renderList());
chrome.storage.onChanged.addListener((c, a) => { if (a === 'local' && (c.control || c.repoTokens || c.privateAccess || c.localFolders)) refreshPendingLibs().then(() => renderList()); });
