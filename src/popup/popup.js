import { siMatch } from '../lib/matcher.js';
import { setupLock } from '../lib/lock-ui.js';
import * as store from '../lib/storage.js';
import { $, h, send, toast, timeAgo, toggle } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { sourceGroup, SOURCE_ORDER, repoStatus, decorate } from '../lib/sources.js';
import * as control from '../lib/control.js';
import * as extUpdate from '../lib/ext-update.js';

let tab = null;
let tabInfo = null;
let settings = null;
let scripts = [];
let repos = { kinds: {}, pending: [] };
let codeHidden = false;

const dashboardUrl = (q = '') => chrome.runtime.getURL('src/options/options.html') + (q ? '?' + q : '');
async function openDashboard(q = '') {
  const base = chrome.runtime.getURL('src/options/options.html');
  const [existing] = await chrome.tabs.query({ url: base + '*' });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true, url: dashboardUrl(q) });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: dashboardUrl(q) });
  }
  window.close();
}

async function load() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  [settings, scripts, repos] = await Promise.all([store.getSettings(), store.getScripts(), repoStatus().catch(() => ({ kinds: {}, pending: [] }))]);
  codeHidden = !!((await control.lockInfo().catch(() => null)) || {}).locked;
  try {
    tabInfo = await send('getTabInfo', { tabId: tab ? tab.id : null });
  } catch (e) {
    tabInfo = { engine: null, tab: null };
  }
  render();
}

function engineBanner(engine) {
  if (!engine || engine.userScripts) return null;
  return h('div', { class: 'banner' },
    h('div', {},
      h('b', {}, 'Limited mode'),
      'Pages with a strict CSP may block scripts. Turn on “Allow User Scripts” for this extension to fix this. ',
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); send('openUserScriptsSettings'); window.close(); } }, 'Open settings →')
    )
  );
}

function statusFor(s, st) {
  const probs = s.enabled ? store.depProblems(s, scripts) : [];
  if (probs.length) return { dot: 'err', text: `blocked: needs ${probs.map((p) => p.name + (p.problem === 'missing' ? ' (missing)' : ' (off)')).join(', ')}` };
  const ran = st && st.ran[s.id];
  const errs = st && st.errorScripts[s.id];
  if (!s.enabled) return { dot: 'off', text: 'disabled' };
  if (errs) return { dot: 'err', text: `${errs} error${errs > 1 ? 's' : ''}${ran ? ` · ran ×${ran.count}` : ''}` };
  const ss = st && st.status && st.status[s.id];
  if (ran && ss && ss.state === 'loading') return { dot: 'busy', text: `loading: ${ss.msg || '…'}` };
  if (ran && ss && ss.state === 'error') return { dot: 'err', text: `failed: ${ss.msg}` };
  if (ran && ss && ss.state === 'ready') return { dot: 'ok', text: `ready${ss.msg ? ': ' + ss.msg : ''} · ran ×${ran.count} · ${timeAgo(ran.last)}` };
  if (ran) return { dot: 'ok', text: `ran ×${ran.count} · ${timeAgo(ran.last)}${ran.trigger && ran.trigger !== 'auto' ? ' · ' + ran.trigger : ''}` };
  return { dot: '', text: s.runAt === 'manual' ? 'manual' : 'not run yet' };
}

function scriptRow(s, st, injectable) {
  const status = statusFor(s, st);
  const runAt = { document_start: 'start', document_end: 'DOM ready', document_idle: 'idle', manual: 'manual' }[s.runAt];
  return h('li', { class: s.enabled ? '' : 'disabled' },
    h('span', { class: 'dot ' + status.dot, title: status.text }),
    h('div', { class: 'grow' },
      h('div', { class: 'name ellipsis', title: s.description || s.name }, s.name, s.type === 'css' ? h('span', { class: 'pill accent', style: { marginLeft: '6px' } }, 'CSS') : null),
      h('div', { class: 'meta ellipsis' }, `${s.version ? 'v' + s.version + ' · ' : ''}${runAt} · ${status.text}`)
    ),
    h('div', { class: 'btns' },
      h('button', {
        class: 'ghost icon', title: 'Run now on this page (ignores URL patterns)', disabled: !injectable,
        onclick: async () => {
          try {
            await send('runScript', { tabId: tab.id, scriptId: s.id });
            toast(`Ran “${s.name}”`, 'ok');
            setTimeout(load, 400);
          } catch (e) { toast(e.message, 'err'); }
        }
      }, icon('play')),
      h('button', { class: 'ghost icon', title: codeHidden ? 'Open in the dashboard (code locked: admin key needed)' : 'Edit', onclick: () => openDashboard('edit=' + s.id) }, icon(codeHidden ? 'eye' : 'pencil'))
    ),
    s.runAt === 'manual' ? null : toggle(s.enabled, async (v) => {
      const r = await store.setEnabledWithDeps(s.id, v);
      if (r.also.length) toast(`${v ? 'Also turned on (required)' : 'Also turned off (they need it)'}: ${r.also.join(', ')}`, 'ok');
      else if (!v && s.type === 'js') toast('Disabled. Reload the page to fully remove its effects.');
    }, s.enabled ? 'Disable script' : 'Enable script')
  );
}

async function renderErrors() {
  const sec = $('#errors-section');
  const ul = $('#errors');
  const st = tabInfo && tabInfo.tab;
  if (!tab || !st || !st.errors) { sec.classList.add('hidden'); return; }
  const logs = (await store.getLogs()).filter((l) => l.level === 'error' && l.tabId === tab.id && l.time >= (st.since || 0) - 1000).slice(0, 5);
  sec.classList.toggle('hidden', !logs.length);
  ul.replaceChildren(...logs.map((l) => h('li', { title: 'Open in logs', onclick: () => openDashboard('view=logs&log=' + l.id) },
    h('div', { class: 'where' }, `${l.scriptName || 'Extension'} · ${l.kind || ''}${l.line ? ` · line ${l.line}${l.col ? ':' + l.col : ''}` : ''}${l.isFrame ? ' · iframe' : ''}`),
    h('div', { class: 'msg' }, l.message)
  )));
}

function render() {
  const injectable = tab && store.isInjectableUrl(tab.url);
  const host = tab ? store.hostOf(tab.url) : '';
  const paused = settings.disabledHosts.includes(host);
  const st = tabInfo && tabInfo.tab;
  const engine = tabInfo && tabInfo.engine;

  $('#global-toggle').checked = settings.enabled;
  $('#enabled-label').textContent = settings.enabled ? 'On' : 'Off';
  $('#engine-line').textContent = engine
    ? (engine.userScripts ? 'User Scripts engine' + (engine.execute ? '' : ' (no instant reinject)') : 'Limited mode (script tags)')
    : '';
  $('#banner-slot').replaceChildren(...[engineBanner(engine)].filter(Boolean));

  $('#host').textContent = injectable ? host || tab.url : 'This page can’t be scripted';
  $('#site-sub').textContent = injectable
    ? (!settings.enabled ? 'Injector is off' : paused ? 'Paused on this site' : st ? `${Object.keys(st.ran).length} ran · ${st.errors} error(s)` : '')
    : 'Chrome blocks extensions on internal pages and the Web Store.';
  $('#pause-toggle').checked = paused;
  $('#pause-toggle').disabled = !injectable || !host;
  for (const id of ['#btn-reinject', '#btn-reload', '#btn-new']) $(id).disabled = !injectable;
  $('#btn-reinject').disabled = !injectable || !settings.enabled || paused;

  const auto = scripts.filter((s) => s.runAt !== 'manual');
  const matching = injectable ? auto.filter((s) => siMatch(tab.url, s.include, s.exclude) || (st && st.ran[s.id])) : [];
  const manual = scripts.filter((s) => s.runAt === 'manual');

  $('#match-count').textContent = injectable ? `${matching.filter((s) => s.enabled).length} active / ${scripts.length} total` : '';
  const ul = $('#matching');
  ul.replaceChildren(...(matching.length
    ? groupRows(matching, st, injectable)
    : [h('span', { class: 'empty' }, injectable ? 'No scripts match this URL. ' : '', injectable ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); newForSite(); } }, 'Create one') : null)]));

  $('#manual-section').classList.toggle('hidden', !manual.length);
  $('#manual').replaceChildren(...manual.map((s) => scriptRow(s, st, injectable)));
  renderErrors();
  // private repos waiting for their token on this PC
  $('#pending-slot').replaceChildren(...repos.pending.map((r) => h('div', { class: 'pending' },
    icon('lock'), h('span', { class: 'grow ellipsis', title: r }, r.split('/')[1], h('span', { class: 'grp-tag' }, 'GitHub · private'), h('div', { class: 'sub' }, 'not connected on this PC')),
    h('button', { class: 'small primary', onclick: () => openDashboard() }, 'Connect'))));
}

// Matching scripts grouped by where they come from (same groups, icons and tags as the dashboard)
function groupRows(list, st, injectable) {
  const groups = new Map();
  for (const sc of list) {
    const g = decorate(sourceGroup(sc, scripts), repos.kinds);
    if (!groups.has(g.key)) groups.set(g.key, { ...g, items: [] });
    groups.get(g.key).items.push(sc);
  }
  const sorted = [...groups.values()].sort((a, b) => SOURCE_ORDER[a.kind] - SOURCE_ORDER[b.kind] || a.label.localeCompare(b.label));
  return sorted.flatMap((g) => [
    h('li', { class: 'pgrp', title: g.title }, icon(g.icon), h('span', { class: 'grow ellipsis' }, g.label), g.tag ? h('span', { class: 'grp-tag' }, g.tag) : null),
    ...store.sortByDeps(g.items).map((sc) => scriptRow(sc, st, injectable))
  ]);
}

function newForSite() {
  const host = store.hostOf(tab.url);
  openDashboard('new=' + encodeURIComponent(host || ''));
}

$('#global-toggle').addEventListener('change', async (e) => {
  settings = await store.saveSettings({ enabled: e.target.checked });
  toast(settings.enabled ? 'Injection on' : 'Injection off');
});
$('#pause-toggle').addEventListener('change', async (e) => {
  const host = store.hostOf(tab.url);
  const set = new Set(settings.disabledHosts);
  if (e.target.checked) set.add(host); else set.delete(host);
  settings = await store.saveSettings({ disabledHosts: [...set] });
  toast(e.target.checked ? `Paused on ${host}. Reload to remove injected JS.` : `Resumed on ${host}`);
});
$('#btn-reinject').addEventListener('click', async () => {
  try {
    const r = await send('reinjectTab', { tabId: tab.id });
    toast(`Reinjected ${r.count} script(s)`, 'ok');
    setTimeout(load, 400);
  } catch (e) { toast(e.message, 'err'); }
});
$('#btn-reload').addEventListener('click', async (e) => {
  await send('reloadTab', { tabId: tab.id, bypassCache: e.shiftKey });
  window.close();
});
$('#btn-new').addEventListener('click', newForSite);
$('#btn-data').addEventListener('click', () => openDashboard('view=data'));
$('#btn-clear-errors').addEventListener('click', async () => {
  await send('clearTabErrors', { tabId: tab.id });
  load();
});
document.querySelectorAll('[data-open]').forEach((a) => a.addEventListener('click', (e) => {
  e.preventDefault();
  openDashboard(a.dataset.open);
}));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.scripts || changes.settings || changes.control || changes.repoTokens)) load();
  if (area === 'session' && tab && changes['tab:' + tab.id]) load();
});

load();

// admin lock / remote status
{
  const slot = document.createElement('div');
  document.querySelector('header.top').after(slot);
  setupLock({ host: slot, lockSel: '#global-toggle, #pause-toggle, #btn-new', toggleSel: '#matching input, #matching .switch input' });
}

// Extension update banner (state written by the background check)
async function renderExtUpdate() {
  const st = await extUpdate.getState().catch(() => null);
  const slot = $('#ext-update-slot');
  const disk = await extUpdate.diskVersion();
  if (disk && extUpdate.newer(disk, extUpdate.current())) {
    return slot.replaceChildren(h('div', { class: 'banner info ext-update' }, h('div', { class: 'grow' },
      h('b', {}, `Update v${disk} downloaded`),
      h('div', { class: 'muted' }, 'It applies by itself when no AnyPricer tab is open or Chrome restarts.'),
      h('button', { class: 'small', onclick: () => send('extApplyNow').catch(() => {}) }, 'Apply now (reloads the extension)'))));
  }
  if (!st || !st.available) return slot.replaceChildren();
  const changes = (st.changes || []).map((c) => h('div', { class: 'ext-ver' }, h('b', {}, 'v' + c.version + (c.title ? ' · ' + c.title : '')), h('ul', {}, c.items.map((i) => h('li', {}, i)))));
  slot.replaceChildren(h('div', { class: 'banner info ext-update' },
    h('div', { class: 'grow' },
      h('b', {}, `Update available: v${st.latest} (you have v${st.current})`),
      changes.length ? h('details', {}, h('summary', {}, 'What changed'), changes) : null,
      h('div', { class: 'muted' }, 'It downloads by itself (every 6 h). To get it now: Start menu → "Update Script Injector", then press Reload.'),
      h('button', { class: 'small', onclick: () => chrome.runtime.reload() }, 'Reload extension'))));
}
renderExtUpdate();
$('#btn-ext-check').textContent = 'v' + extUpdate.current();
$('#btn-ext-check').addEventListener('click', async (e) => {
  e.preventDefault();
  try {
    const { state } = await send('extUpdateCheck');
    if (state.error) toast(state.error, 'err');
    else if (!extUpdate.newer(state.latest, state.current)) toast('Up to date (v' + state.current + ')');
    renderExtUpdate();
  } catch (err) { toast(err.message, 'err'); }
});
