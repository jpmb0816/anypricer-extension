import { siMatch, toNativeMatches } from './lib/matcher.js';
import { buildScriptCode, injectViaTag } from './lib/wrapper.js';
import * as store from './lib/storage.js';
import * as sync from './sync.js';
import * as installer from './lib/installer.js';
import * as control from './lib/control.js';
import * as extUpdate from './lib/ext-update.js';

/* ======================================================================
 * Engine detection
 * ==================================================================== */

function userScriptsAvailable() {
  try {
    if (!chrome.userScripts) return false;
    // Throws synchronously when "Allow User Scripts" / developer mode is off.
    chrome.userScripts.getScripts().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

function engineInfo() {
  const us = userScriptsAvailable();
  return {
    userScripts: us,
    execute: us && typeof chrome.userScripts.execute === 'function',
    mode: us ? 'userScripts' : 'fallback',
    chromeVersion: (/Chrome\/(\d+)/.exec(navigator.userAgent) || [])[1] || '?'
  };
}

/* ======================================================================
 * Cached state
 * ==================================================================== */

let cache = null;
async function loadAll() {
  if (!cache) {
    const [settings, scripts, token, block] = await Promise.all([store.getSettings(), store.getScripts(), store.getToken(), control.blocked()]);
    // Turned off / access removed by the admin → behave exactly like the main switch is off
    cache = { settings: block ? { ...settings, enabled: false } : settings, scripts, token, block };
  }
  return cache;
}

const isHostDisabled = (settings, url) => settings.disabledHosts.includes(store.hostOf(url));

/* ======================================================================
 * Serial queues
 * ==================================================================== */

function queue() {
  let chain = Promise.resolve();
  return (fn) => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };
}
const syncQueue = queue();
const tabQueue = queue();
const logQueue = queue();
const menuQueue = queue();

/* ======================================================================
 * Logs & stats (buffered)
 * ==================================================================== */

let logBuf = [];
let statBuf = {};
let logTimer = null;

function addLog(entry) {
  logBuf.push({ id: crypto.randomUUID(), time: Date.now(), level: 'error', source: 'extension', ...entry });
  if (entry.scriptId && (entry.level || 'error') === 'error') bumpStat(entry.scriptId, { errors: 1, lastError: Date.now() });
  scheduleFlush();
}

function bumpStat(id, patch) {
  const s = statBuf[id] || (statBuf[id] = { runs: 0, errors: 0 });
  if (patch.runs) s.runs += patch.runs;
  if (patch.errors) s.errors += patch.errors;
  if (patch.lastRun) s.lastRun = patch.lastRun;
  if (patch.lastError) s.lastError = patch.lastError;
  scheduleFlush();
}

function scheduleFlush() {
  if (!logTimer) logTimer = setTimeout(() => logQueue(flush), 300);
}

async function flush() {
  logTimer = null;
  const items = logBuf;
  const stats = statBuf;
  logBuf = [];
  statBuf = {};
  if (!items.length && !Object.keys(stats).length) return;
  const { settings } = await loadAll();
  const data = await chrome.storage.local.get(['logs', 'stats']);
  const out = {};
  if (items.length) out.logs = items.reverse().concat(data.logs || []).slice(0, Math.max(50, settings.maxLogs || 500));
  if (Object.keys(stats).length) {
    const all = data.stats || {};
    for (const [id, s] of Object.entries(stats)) {
      const cur = all[id] || { runs: 0, errors: 0 };
      all[id] = {
        runs: cur.runs + s.runs,
        errors: cur.errors + s.errors,
        lastRun: s.lastRun || cur.lastRun,
        lastError: s.lastError || cur.lastError
      };
    }
    out.stats = all;
  }
  await chrome.storage.local.set(out);
}

const NOISE = /Frame with ID|No tab with id|tab was closed|No frame with id|Cannot access a chrome|The extensions gallery cannot be scripted|Frame .* was removed|document was unloaded/i;

function logInjectionError(s, tabId, url, err) {
  const msg = String((err && err.message) || err);
  if (NOISE.test(msg)) return;
  addLog({ level: 'error', source: 'extension', kind: 'injection', scriptId: s && s.id, scriptName: s && s.name, tabId, url, message: msg });
  if (tabId != null) tabQueue(async () => {
    const st = await getTabState(tabId);
    st.errors++;
    if (s) st.errorScripts[s.id] = (st.errorScripts[s.id] || 0) + 1;
    await saveTabState(tabId, st);
    await updateBadge(tabId);
  });
}

/* ======================================================================
 * Notifications
 * ==================================================================== */

const lastNotify = {};
async function notifyError(name, message, scriptId) {
  const { settings } = await loadAll();
  if (!settings.notifyOnError) return;
  const now = Date.now();
  if (lastNotify[scriptId] && now - lastNotify[scriptId] < 10000) return;
  lastNotify[scriptId] = now;
  chrome.notifications.create('err:' + scriptId + ':' + now, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: `Script error: ${name || 'unknown'}`,
    message: String(message || '').slice(0, 250),
    priority: 1
  });
}

chrome.notifications.onClicked.addListener((nid) => {
  if (nid.startsWith('err:')) openDashboard('view=logs');
  if (nid === 'ext-update') openDashboard('view=settings');
  chrome.notifications.clear(nid);
});

/* ======================================================================
 * Tab state + badge
 * ==================================================================== */

const tabStates = new Map();
const newTabState = (url = '', documentId = null) => ({ url, documentId, since: Date.now(), ran: {}, errors: 0, errorScripts: {}, cssApplied: [], status: {} });

async function getTabState(tabId) {
  if (tabStates.has(tabId)) return tabStates.get(tabId);
  const k = 'tab:' + tabId;
  const st = (await chrome.storage.session.get(k))[k] || newTabState();
  tabStates.set(tabId, st);
  return st;
}

async function saveTabState(tabId, st) {
  tabStates.set(tabId, st);
  await chrome.storage.session.set({ ['tab:' + tabId]: st });
}

function resetTab(tabId, url, documentId) {
  return tabQueue(async () => {
    const st = await getTabState(tabId);
    if (documentId && st.documentId === documentId) return;
    await saveTabState(tabId, newTabState(url, documentId));
    await updateBadge(tabId);
  });
}

async function updateBadge(tabId) {
  try {
    const { settings } = await loadAll();
    const st = await getTabState(tabId);
    let text = '';
    let color = '#16a34a';
    let title = 'Script Injector';
    if (!settings.enabled) {
      text = 'OFF';
      color = '#6b7280';
      title += ' (off)';
    } else if (st.url && isHostDisabled(settings, st.url)) {
      text = '||';
      color = '#6b7280';
      title += ' (paused on this site)';
    } else if (st.errors) {
      text = st.errors > 99 ? '99+' : String(st.errors);
      color = '#dc2626';
      title += ` — ${st.errors} error(s)`;
    } else if (st.status && Object.values(st.status).some((x) => x.state === 'loading')) {
      const busy = Object.values(st.status).filter((x) => x.state === 'loading').length;
      text = '…';
      color = '#2563eb';
      title += ` — ${busy} script(s) loading`;
    } else {
      const n = Object.keys(st.ran).length;
      if (n) {
        if (settings.showBadge) text = String(n);
        title += ` — ${n} script(s) ran`;
      }
    }
    if (!settings.showBadge && text !== 'OFF') text = '';
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
    await chrome.action.setTitle({ tabId, title });
  } catch {
    /* tab closed */
  }
}

async function updateAllBadges() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((t) => updateBadge(t.id)));
}

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStates.delete(tabId);
  chrome.storage.session.remove('tab:' + tabId);
});

/* ======================================================================
 * Page events (from relay.js)
 * ==================================================================== */

async function handlePageEvent(p, sender) {
  const tabId = sender.tab && sender.tab.id;
  if (tabId == null || !p || typeof p !== 'object') return;
  const { token, settings } = await loadAll();
  if (p.__scriptInjector !== token) return;

  const base = {
    scriptId: String(p.scriptId || ''),
    scriptName: String(p.scriptName || ''),
    url: String(p.url || sender.url || ''),
    tabId,
    frameId: sender.frameId,
    isFrame: !!p.isFrame,
    trigger: String(p.trigger || '')
  };

  await tabQueue(async () => {
    let st = await getTabState(tabId);
    if (sender.frameId === 0 && sender.documentId && st.documentId && st.documentId !== sender.documentId) {
      st = newTabState(sender.tab.url, sender.documentId);
    }
    if (p.type === 'ran') {
      const prev = st.ran[base.scriptId];
      st.ran[base.scriptId] = {
        name: base.scriptName,
        count: (prev ? prev.count : 0) + 1,
        last: Date.now(),
        trigger: base.trigger,
        frames: (prev ? prev.frames : 0) + (base.isFrame ? 1 : 0)
      };
      bumpStat(base.scriptId, { runs: 1, lastRun: Date.now() });
    } else if (p.type === 'status') {
      if (!st.status) st.status = {};
      st.status[base.scriptId] = { state: String(p.state || ''), msg: String(p.message || '').slice(0, 200), t: Date.now() };
    } else if (p.type === 'error') {
      st.errors++;
      st.errorScripts[base.scriptId] = (st.errorScripts[base.scriptId] || 0) + 1;
    }
    await saveTabState(tabId, st);
    await updateBadge(tabId);
  });

  if (p.type === 'error') {
    addLog({
      ...base,
      level: 'error',
      source: 'page',
      kind: String(p.kind || 'exception'),
      message: String(p.message || '').slice(0, 5000),
      stack: String(p.stack || '').slice(0, 10000),
      line: p.line,
      col: p.col
    });
    notifyError(base.scriptName, p.message, base.scriptId);
  } else if (p.type === 'console' && settings.logConsole) {
    addLog({ ...base, level: 'console', source: 'page', consoleLevel: String(p.level || 'log'), message: String(p.message || '').slice(0, 4000) });
  }
}

/* ======================================================================
 * Per-script data storage (injector.storage) — chrome.storage.local keys:
 *   sdata:<scriptId>:<key>   the value
 *   sidx:<scriptId>          { key: { updated, size } } index for the dashboard
 * ==================================================================== */

const SDATA = (id, key) => `sdata:${id}:${key}`;
// per-script key index (sidx:<id>), cached here so a script saving many records does not rewrite the whole index each time
const idxCache = new Map(), idxTimers = new Map(), idxWriting = new Set();
async function idxOf(id) { if (!idxCache.has(id)) idxCache.set(id, (await chrome.storage.local.get(SIDX(id)))[SIDX(id)] || {}); return idxCache.get(id); }
function idxLater(id) {
  clearTimeout(idxTimers.get(id));
  idxTimers.set(id, setTimeout(async () => { idxTimers.delete(id); if (!idxCache.has(id)) return; idxWriting.add(id); await chrome.storage.local.set({ [SIDX(id)]: idxCache.get(id) }); idxWriting.delete(id); }, 2000));
}
chrome.storage.onChanged.addListener((c, area) => { // index changed elsewhere (dashboard, sync, clean-up) → reload it next time
  if (area !== 'local') return;
  for (const k of Object.keys(c)) if (k.startsWith('sidx:')) { const id = k.slice(5); if (!idxWriting.has(id) && !idxTimers.has(id)) idxCache.delete(id); }
});
const SIDX = (id) => `sidx:${id}`;
const recentKvWrites = new Map(); // storage key → JSON of the value a script just wrote (not echoed back as "changed")
const jsonOf = (v) => { try { return JSON.stringify(v === undefined ? null : v); } catch (_) { return ''; } };
const kvQueue = queue();

async function handleKv(p, sender) {
  const { token, scripts } = await loadAll();
  if (p.__scriptInjector !== token) return { ok: false, error: 'Invalid token' };
  const id = String(p.scriptId || '');
  if (!scripts.some((s) => s.id === id)) return { ok: false, error: 'Unknown script' };
  const op = String(p.op || '');
  const key = p.key == null ? '' : String(p.key);
  if (op !== 'list' && op !== 'getAll' && op !== 'sync' && op !== 'syncnow' && op !== 'synccheck' && (!key || key.length > 300)) return { ok: false, error: 'Invalid key' };
  if (op === 'sync') { // online database status + how many of this script's changes still wait to upload
    const g = await chrome.storage.local.get(['sync:status', 'sync:outbox']);
    const st = g['sync:status'] || {}, ob = g['sync:outbox'] || {}, pre = SDATA(id, '');
    const mine = Object.keys(ob).filter((k) => k.startsWith(pre));
    return { ok: true, result: { state: st.state || 'off', lastSync: st.lastSync || 0, lastPush: st.lastPush || 0, error: st.error || '', pendingMine: mine.length, pendingKeys: mine.map((k) => k.slice(pre.length)) } };
  }
  if (op === 'syncnow') { // a script asks to upload now (e.g. "Upload now" after a failed save); value = keys to upload again (optional)
    const ks = Array.isArray(p.value) ? p.value.map(String).filter((k) => k && k.length <= 300).slice(0, 2000) : [];
    if (ks.length) await sync.queueKeys(ks.map((k) => SDATA(id, k)));
    const r = await sync.syncNow({ pullToo: false }).catch((e) => ({ state: 'error', error: e.message }));
    return { ok: true, result: { state: r.state, error: r.error || '', pending: r.pending || 0 } };
  }
  if (op === 'synccheck') { // read keys back from the online database: { state, checked, missing, differ }
    const ks = Array.isArray(p.value) ? p.value.map(String).filter((k) => k && k.length <= 300).slice(0, 2000) : [];
    return { ok: true, result: await sync.checkOnline(id, ks) };
  }
  return kvQueue(async () => {
    if (op === 'get') {
      const k = SDATA(id, key);
      return { ok: true, result: (await chrome.storage.local.get(k))[k] ?? null };
    }
    if (op === 'list') {
      const idx = (await chrome.storage.local.get(SIDX(id)))[SIDX(id)] || {};
      return { ok: true, result: idx };
    }
    if (op === 'getAll') {
      const idx = (await chrome.storage.local.get(SIDX(id)))[SIDX(id)] || {};
      const keys = Object.keys(idx);
      const data = keys.length ? await chrome.storage.local.get(keys.map((k) => SDATA(id, k))) : {};
      const out = {};
      for (const k of keys) if (data[SDATA(id, k)] !== undefined) out[k] = data[SDATA(id, k)];
      return { ok: true, result: out };
    }
    const idx = await idxOf(id);
    if (op === 'set') {
      let size = 0;
      try { size = JSON.stringify(p.value ?? null).length; } catch (_) { return { ok: false, error: 'Value is not serialisable' }; }
      const isNew = !idx[key];
      idx[key] = { updated: Date.now(), size, tabUrl: sender && sender.tab ? sender.tab.url : '' };
      recentKvWrites.set(SDATA(id, key), jsonOf(p.value ?? null));
      // a new key is indexed right away; for an existing key only its size / time change: written a moment later in one go
      if (isNew) { idxWriting.add(id); await chrome.storage.local.set({ [SDATA(id, key)]: p.value ?? null, [SIDX(id)]: idx }); idxWriting.delete(id); }
      else { await chrome.storage.local.set({ [SDATA(id, key)]: p.value ?? null }); idxLater(id); }
      return { ok: true, result: true };
    }
    if (op === 'remove') {
      delete idx[key];
      recentKvWrites.set(SDATA(id, key), jsonOf(null));
      await chrome.storage.local.remove(SDATA(id, key));
      idxWriting.add(id); await chrome.storage.local.set({ [SIDX(id)]: idx }); idxWriting.delete(id);
      return { ok: true, result: true };
    }
    return { ok: false, error: 'Unknown operation' };
  });
}

// Data edited from the dashboard → notify the running scripts in all tabs
async function broadcastKvChange(storageKey, newValue) {
  const m = /^sdata:([^:]+):(.*)$/.exec(storageKey);
  if (!m) return;
  // Skip the change if it is exactly what the script itself just wrote
  if (recentKvWrites.has(storageKey) && recentKvWrites.get(storageKey) === jsonOf(newValue === undefined ? null : newValue)) {
    recentKvWrites.delete(storageKey);
    return;
  }
  const { token } = await loadAll();
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!store.isInjectableUrl(tab.url)) continue;
    chrome.tabs.sendMessage(tab.id, { type: 'kv-changed', token, scriptId: m[1], key: m[2] }).catch(() => {});
  }
}

/* ======================================================================
 * Code building
 * ==================================================================== */

async function requireCodeFor(s) {
  if (!s.requires.length) return '';
  const cache = await store.getRequireCache(s.requires);
  return s.requires
    .map((u) => (cache[u]
      ? `/* @require ${u} */\n${cache[u].code}`
      : `console.warn(${JSON.stringify('[Script Injector] @require not downloaded yet: ' + u)});`))
    .join('\n;\n');
}

async function buildFor(s, opts = {}) {
  const { settings, token } = await loadAll();
  return buildScriptCode(s, {
    token,
    disabledHosts: settings.disabledHosts,
    statusStyle: settings.statusStyle || (settings.statusPill === false ? 'off' : 'auto'),
    requireCode: await requireCodeFor(s),
    ...opts
  });
}

const isAutoJs = (s) => s.enabled && s.type === 'js' && s.runAt !== 'manual' && s.include.length > 0;

/* ======================================================================
 * userScripts registration
 * ==================================================================== */

let syncTimer = null;
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncQueue(syncRegistrations), 60);
}

async function syncRegistrations() {
  const eng = engineInfo();
  await chrome.storage.session.set({ engine: eng });
  if (!eng.userScripts) return { engine: eng, registered: 0 };

  const { settings, scripts } = await loadAll();
  try {
    await chrome.userScripts.unregister();
  } catch {
    /* nothing registered */
  }
  if (!settings.enabled) return { engine: eng, registered: 0 };

  let registered = 0;
  for (const s of store.sortByDeps(scripts)) {
    if (!isAutoJs(s) || store.depsBlocked(s, scripts)) continue; // required scripts first; never without them
    const code = await buildFor(s, { trigger: 'auto' });
    const base = {
      id: s.id,
      js: [{ code }],
      runAt: s.runAt,
      allFrames: s.allFrames,
      world: s.world === 'USER_SCRIPT' ? 'USER_SCRIPT' : 'MAIN'
    };
    const native = toNativeMatches(s.include);
    try {
      await chrome.userScripts.register([{ ...base, matches: native || ['<all_urls>'] }]);
      registered++;
    } catch (e) {
      let err = e;
      if (native) {
        try {
          await chrome.userScripts.register([{ ...base, matches: ['<all_urls>'] }]);
          registered++;
          continue;
        } catch (e2) {
          err = e2;
        }
      }
      addLog({ level: 'error', kind: 'register', scriptId: s.id, scriptName: s.name, message: 'Failed to register: ' + err.message });
    }
  }
  return { engine: eng, registered };
}

async function checkEngine() {
  const { engine } = await chrome.storage.session.get('engine');
  const now = engineInfo();
  if (!engine || engine.userScripts !== now.userScripts) scheduleSync();
  return now;
}

/* ======================================================================
 * Injection primitives
 * ==================================================================== */

async function framesFor(tabId, s) {
  if (!s.allFrames) {
    const tab = await chrome.tabs.get(tabId);
    return [{ frameId: 0, url: tab.url }];
  }
  return (await chrome.webNavigation.getAllFrames({ tabId })) || [];
}

async function insertCss(tabId, frameIds, s) {
  try {
    await chrome.scripting.insertCSS({ target: { tabId, frameIds }, css: s.code, origin: 'USER' });
    return true;
  } catch (e) {
    logInjectionError(s, tabId, '', e);
    return false;
  }
}

async function removeCssEverywhere(css, tabs) {
  if (!css) return;
  tabs = tabs || (await chrome.tabs.query({}));
  await Promise.all(
    tabs
      .filter((t) => store.isInjectableUrl(t.url))
      .map((t) => chrome.scripting.removeCSS({ target: { tabId: t.id, allFrames: true }, css, origin: 'USER' }).catch(() => {}))
  );
}

/** Applies a CSS script to a tab, honouring patterns per frame (unless forced). */
async function applyCssToTab(tabId, s, force) {
  const { settings } = await loadAll();
  const frames = await framesFor(tabId, s);
  const ids = frames
    .filter((f) => store.isInjectableUrl(f.url) && (force || (!isHostDisabled(settings, f.url) && siMatch(f.url, s.include, s.exclude))))
    .map((f) => f.frameId);
  if (!ids.length) return false;
  const ok = await insertCss(tabId, ids, s);
  if (ok) recordRan(tabId, s, force ? 'manual' : 'auto');
  return ok;
}

function recordRan(tabId, s, trigger) {
  return tabQueue(async () => {
    const st = await getTabState(tabId);
    const prev = st.ran[s.id];
    st.ran[s.id] = { name: s.name, count: (prev ? prev.count : 0) + 1, last: Date.now(), trigger, frames: 0 };
    bumpStat(s.id, { runs: 1, lastRun: Date.now() });
    await saveTabState(tabId, st);
    await updateBadge(tabId);
  });
}

/** Injects a JS script without userScripts (script tag in MAIN world). */
async function injectFallback(tabId, target, s, opts) {
  const code = await buildFor(s, opts);
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, ...target },
      world: 'MAIN',
      injectImmediately: true,
      func: injectViaTag,
      args: [code, s.id]
    });
    const failed = results.find((r) => r.result && !r.result.ok);
    if (failed) logInjectionError(s, tabId, '', new Error(failed.result.error));
    return !failed;
  } catch (e) {
    logInjectionError(s, tabId, '', e);
    return false;
  }
}

/**
 * Runs a script in a tab right now.
 * force=true bypasses URL patterns / paused sites (manual "Run now").
 */
async function executeNow(tabId, s, { force = false, trigger = 'reinject', frameIds = null } = {}) {
  if (s.type === 'css') {
    await chrome.scripting.removeCSS({ target: { tabId, allFrames: true }, css: s.code, origin: 'USER' }).catch(() => {});
    return applyCssToTab(tabId, s, force);
  }
  const target = frameIds ? { frameIds } : { allFrames: s.allFrames };
  const eng = engineInfo();
  if (eng.execute) {
    try {
      const code = await buildFor(s, { force, trigger });
      const results = await chrome.userScripts.execute({
        target: { tabId, ...target },
        js: [{ code }],
        world: s.world === 'USER_SCRIPT' ? 'USER_SCRIPT' : 'MAIN',
        injectImmediately: true
      });
      const failed = (results || []).find((r) => r.error);
      if (failed) logInjectionError(s, tabId, '', new Error(failed.error));
      return !failed;
    } catch (e) {
      logInjectionError(s, tabId, '', e);
      return false;
    }
  }
  return injectFallback(tabId, target, s, { force, trigger });
}

async function reinjectTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!store.isInjectableUrl(tab.url)) throw new Error('Chrome does not allow scripts on this page.');
  const { settings, scripts } = await loadAll();
  if (!settings.enabled) throw new Error('Script Injector is turned off.');
  if (isHostDisabled(settings, tab.url)) throw new Error('Injection is paused on this site.');
  let count = 0;
  for (const s of store.sortByDeps(scripts)) {
    if (!s.enabled || s.runAt === 'manual' || !s.include.length || store.depsBlocked(s, scripts)) continue;
    if (!s.allFrames && !siMatch(tab.url, s.include, s.exclude)) continue;
    if (await executeNow(tabId, s, { trigger: 'reinject' })) count++;
  }
  return { count };
}

async function reinjectScriptEverywhere(scriptId) {
  const { settings, scripts } = await loadAll();
  const s = scripts.find((x) => x.id === scriptId);
  if (!s || !s.enabled || s.runAt === 'manual' || !settings.enabled) return { tabs: 0 };
  const tabs = await chrome.tabs.query({});
  let n = 0;
  for (const t of tabs) {
    if (!store.isInjectableUrl(t.url) || isHostDisabled(settings, t.url)) continue;
    if (!s.allFrames && !siMatch(t.url, s.include, s.exclude)) continue;
    if (await executeNow(t.id, s, { trigger: 'reinject' })) n++;
  }
  return { tabs: n };
}

async function runScript(tabId, scriptId) {
  const { scripts } = await loadAll();
  const s = scripts.find((x) => x.id === scriptId);
  if (!s) throw new Error('Script not found.');
  const tab = await chrome.tabs.get(tabId);
  if (!store.isInjectableUrl(tab.url)) throw new Error('Chrome does not allow scripts on this page.');
  const ok = await executeNow(tabId, s, { force: true, trigger: 'manual', frameIds: s.allFrames ? null : [0] });
  return { ok };
}

/* ======================================================================
 * Navigation-driven injection (CSS always; JS in fallback mode; SPA re-runs)
 * ==================================================================== */

const NAV_FILTER = { url: [{ schemes: ['http', 'https', 'file', 'ftp'] }] };

async function onNav(d, phase) {
  if (d.tabId < 0 || !store.isInjectableUrl(d.url)) return;
  const { settings, scripts } = await loadAll();
  if (!settings.enabled || isHostDisabled(settings, d.url)) return;
  const fallback = !userScriptsAvailable();
  for (const s of store.sortByDeps(scripts)) {
    if (!s.enabled || s.runAt !== phase || !s.include.length || store.depsBlocked(s, scripts)) continue;
    if (d.frameId !== 0 && !s.allFrames) continue;
    if (!siMatch(d.url, s.include, s.exclude)) continue;
    if (s.type === 'css') {
      if (await insertCss(d.tabId, [d.frameId], s)) recordRan(d.tabId, s, 'auto');
    } else if (fallback) {
      injectFallback(d.tabId, { frameIds: [d.frameId] }, s, { trigger: 'auto' });
    }
  }
}

async function onSpa(d) {
  if (d.tabId < 0 || !store.isInjectableUrl(d.url)) return;
  const { settings, scripts } = await loadAll();
  if (!settings.enabled || isHostDisabled(settings, d.url)) return;
  for (const s of store.sortByDeps(scripts)) {
    if (!s.enabled || !s.runOnSpa || s.runAt === 'manual' || store.depsBlocked(s, scripts)) continue;
    if (d.frameId !== 0 && !s.allFrames) continue;
    const matches = siMatch(d.url, s.include, s.exclude);
    if (s.type === 'css') {
      // Keep CSS in sync with the new URL: add when matching, remove when not.
      await chrome.scripting.removeCSS({ target: { tabId: d.tabId, frameIds: [d.frameId] }, css: s.code, origin: 'USER' }).catch(() => {});
      if (matches) await insertCss(d.tabId, [d.frameId], s);
    } else if (matches) {
      executeNow(d.tabId, s, { trigger: 'spa', frameIds: [d.frameId] });
    }
  }
}

chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId === 0 && d.tabId >= 0) resetTab(d.tabId, d.url, d.documentId);
  onNav(d, 'document_start');
}, NAV_FILTER);
chrome.webNavigation.onDOMContentLoaded.addListener((d) => onNav(d, 'document_end'), NAV_FILTER);
chrome.webNavigation.onCompleted.addListener((d) => onNav(d, 'document_idle'), NAV_FILTER);
chrome.webNavigation.onHistoryStateUpdated.addListener(onSpa, NAV_FILTER);

/* ======================================================================
 * Live CSS updates when scripts/settings change
 * ==================================================================== */

const activeCss = (scripts, settings) => (settings.enabled ? scripts.filter((s) => s.type === 'css' && s.enabled && s.runAt !== 'manual') : []);

async function applyCssChanges(oldScripts, newScripts, oldSettings, newSettings) {
  const before = activeCss(oldScripts, oldSettings);
  const after = activeCss(newScripts, newSettings);
  const sig = (list, st) => JSON.stringify([list.map((s) => [s.id, s.code, s.include, s.exclude, s.allFrames]), st.disabledHosts]);
  if (sig(before, oldSettings) === sig(after, newSettings)) return;
  const tabs = (await chrome.tabs.query({})).filter((t) => store.isInjectableUrl(t.url));
  for (const s of before) await removeCssEverywhere(s.code, tabs);
  for (const t of tabs) for (const s of after) await applyCssToTab(t.id, s, false);
}

/* ======================================================================
 * Reload tabs when a "reloadOnDisable" script is turned off
 * (script disabled/deleted, injector turned off, or site paused)
 * ==================================================================== */

async function reloadDisabledTabs(oldScripts, newScripts, oldSettings, newSettings) {
  const newMap = new Map(newScripts.map((s) => [s.id, s]));
  const watched = oldScripts.filter((s) => s.reloadOnDisable && s.enabled && oldSettings.enabled);
  if (!watched.length) return;
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (!store.isInjectableUrl(t.url)) continue;
    const st = await getTabState(t.id);
    const nowPaused = isHostDisabled(newSettings, t.url) && !isHostDisabled(oldSettings, t.url);
    const hit = watched.some((s) => {
      if (!st.ran[s.id]) return false;
      const n = newMap.get(s.id);
      return !newSettings.enabled || nowPaused || !n || !n.enabled;
    });
    if (hit) chrome.tabs.reload(t.id).catch(() => {});
  }
}

/* ======================================================================
 * Context menus
 * ==================================================================== */

let menuTimer = null;
function scheduleMenus() {
  clearTimeout(menuTimer);
  menuTimer = setTimeout(() => menuQueue(rebuildMenus), 100);
}

function menu(opts) {
  return new Promise((resolve) => chrome.contextMenus.create(opts, () => resolve(void chrome.runtime.lastError)));
}

async function rebuildMenus() {
  const { settings, scripts } = await loadAll();
  await chrome.contextMenus.removeAll();
  const contexts = ['all'];
  await menu({ id: 'root', title: 'Script Injector', contexts });
  await menu({ id: 'reinject', parentId: 'root', title: 'Reinject scripts on this page', contexts });
  await menu({ id: 'reload', parentId: 'root', title: 'Reload page', contexts });
  await menu({ id: 'pause', parentId: 'root', title: 'Pause / resume on this site', contexts });
  await menu({ id: 'toggle', parentId: 'root', title: settings.enabled ? 'Turn injector OFF' : 'Turn injector ON', contexts });
  const runnable = scripts
    .filter((s) => s.enabled || s.runAt === 'manual')
    .sort((a, b) => (a.runAt === 'manual' ? 0 : 1) - (b.runAt === 'manual' ? 0 : 1))
    .slice(0, 40);
  if (runnable.length) {
    await menu({ id: 'sep1', parentId: 'root', type: 'separator', contexts });
    await menu({ id: 'run', parentId: 'root', title: 'Run script now', contexts });
    for (const s of runnable) {
      await menu({ id: 'run:' + s.id, parentId: 'run', title: (s.runAt === 'manual' ? '▶ ' : '') + s.name + (s.type === 'css' ? ' (CSS)' : ''), contexts });
    }
  }
  await menu({ id: 'sep2', parentId: 'root', type: 'separator', contexts });
  await menu({ id: 'dashboard', parentId: 'root', title: 'Open dashboard', contexts });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const id = String(info.menuItemId);
  try {
    if (id === 'reinject' && tab) await reinjectTab(tab.id);
    else if (id === 'reload' && tab) await chrome.tabs.reload(tab.id);
    else if (id === 'pause' && tab) await togglePause(tab.url);
    else if (id === 'toggle') await toggleEnabled();
    else if (id === 'dashboard') await openDashboard();
    else if (id.startsWith('run:') && tab) await runScript(tab.id, id.slice(4));
  } catch (e) {
    addLog({ level: 'warn', kind: 'action', message: e.message, tabId: tab && tab.id, url: tab && tab.url });
  }
});

/* ======================================================================
 * Actions
 * ==================================================================== */

async function toggleEnabled() {
  if (await control.isLocked()) return; // locked by the admin
  const s = await store.getSettings();
  await store.saveSettings({ enabled: !s.enabled });
}

async function togglePause(url) {
  if (await control.isLocked()) return;
  return togglePause_(url);
}
async function togglePause_(url) {
  const host = store.hostOf(url);
  if (!host) return;
  const s = await store.getSettings();
  const set = new Set(s.disabledHosts);
  if (set.has(host)) set.delete(host); else set.add(host);
  await store.saveSettings({ disabledHosts: [...set] });
}

async function openDashboard(query = '') {
  await chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html') + (query ? '?' + query : '') });
}

chrome.commands.onCommand.addListener(async (cmd, tab) => {
  try {
    if (cmd === 'toggle-enabled') await toggleEnabled();
    else if (cmd === 'open-dashboard') await openDashboard();
    else if (cmd === 'reinject-tab') {
      const t = tab || (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
      if (t) await reinjectTab(t.id);
    }
  } catch (e) {
    addLog({ level: 'warn', kind: 'action', message: e.message });
  }
});

/* ======================================================================
 * Messaging
 * ==================================================================== */

const handlers = {
  extUpdateCheck: async () => ({ state: await extUpdate.check(), disk: await applyDiskUpdate() }),
  extApplyNow: async () => applyDiskUpdate(true),
  // ---- online sync ----
  async syncStatus() { return { status: await sync.getStatus() }; },
  async syncNow() { return { result: await sync.syncNow() }; },
  async syncTest() { return { result: await sync.testConnection() }; },
  async syncSaveConfig({ config }) {
    const prev = await sync.getConfig();
    if (config) await chrome.storage.local.set({ syncConfig: config }); else await chrome.storage.local.remove('syncConfig');
    const next = await sync.getConfig();
    if (!prev || !next || prev.supabaseUrl !== next.supabaseUrl) await chrome.storage.local.remove(['sync:initFor', 'sync:cursor']);
    return { result: await sync.syncNow() };
  },
  async syncSetDeviceName({ name }) {
    const d = await sync.getDevice();
    d.name = String(name || '').trim().slice(0, 40) || d.name;
    await chrome.storage.local.set({ 'sync:device': d });
    return { device: d };
  },
  async getTabInfo({ tabId }) {
    const engine = await checkEngine();
    const st = tabId != null ? await getTabState(tabId) : null;
    return { engine, tab: st };
  },
  // These invalidate the cache first: the page may have just written storage.
  async reinjectTab({ tabId }) {
    cache = null;
    return reinjectTab(tabId);
  },
  async runScript({ tabId, scriptId }) {
    cache = null;
    return runScript(tabId, scriptId);
  },
  async reinjectScript({ scriptId }) {
    cache = null;
    return reinjectScriptEverywhere(scriptId);
  },
  async resync() {
    cache = null;
    return syncQueue(syncRegistrations);
  },
  async engine() {
    return { engine: engineInfo() };
  },
  async reloadTab({ tabId, bypassCache }) {
    await chrome.tabs.reload(tabId, { bypassCache: !!bypassCache });
    return {};
  },
  async clearTabErrors({ tabId }) {
    await tabQueue(async () => {
      const st = await getTabState(tabId);
      st.errors = 0;
      st.errorScripts = {};
      await saveTabState(tabId, st);
      await updateBadge(tabId);
    });
    return {};
  },
  async openUserScriptsSettings() {
    await chrome.tabs.create({ url: 'chrome://extensions/?id=' + chrome.runtime.id });
    return {};
  },
  async openUrl({ url }) {
    await chrome.tabs.create({ url });
    return {};
  }
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.type === 'page-event') {
    if (msg.payload && msg.payload.type === 'kv') {
      handleKv(msg.payload, sender).then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    handlePageEvent(msg.payload, sender);
    return false;
  }
  // Privileged commands only from our own extension pages.
  if (sender.id !== chrome.runtime.id || !String(sender.url || '').startsWith(chrome.runtime.getURL(''))) return false;
  const fn = handlers[msg.type];
  if (!fn) return false;
  fn(msg).then(
    (r) => sendResponse({ ok: true, ...(r || {}) }),
    (e) => sendResponse({ ok: false, error: e.message })
  );
  return true;
});

/* ======================================================================
 * Storage changes → re-register, menus, CSS, badges
 * ==================================================================== */

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const k of Object.keys(changes)) {
    if (!k.startsWith('sdata:')) continue;
    broadcastKvChange(k, changes[k].newValue);
    sync.noteChange(k, changes[k].newValue); // queue for online auto-sync
  }
  if (changes.control) { cache = null; scheduleSync(); updateAllBadges(); scheduleControl().catch(() => {}); }
  if (changes.scripts) scheduleRestore();
  // a script that is gone (deleted, removed from its library, …) takes its saved data with it
  if (changes.scripts) {
    const now = new Set((changes.scripts.newValue || []).map((s) => s.id));
    const gone = (changes.scripts.oldValue || []).map((s) => s.id).filter((id) => id && !now.has(id));
    if (gone.length) chrome.storage.local.get(null).then((all) => {
      const keys = Object.keys(all).filter((k) => gone.some((id) => k.startsWith('sdata:' + id + ':') || k === 'sidx:' + id));
      if (keys.length) chrome.storage.local.remove(keys);
    }).catch(() => {});
  }
  const scriptsChanged = !!changes.scripts;
  const settingsChanged = !!changes.settings;
  const requiresChanged = Object.keys(changes).some((k) => k.startsWith('req:'));
  if (!scriptsChanged && !settingsChanged && !requiresChanged) return;

  cache = null;
  scheduleSync();
  if (!scriptsChanged && !settingsChanged) return;
  scheduleMenus();

  (async () => {
    const now = await loadAll();
    const oldScripts = scriptsChanged ? (changes.scripts.oldValue || []).map(store.normalizeScript) : now.scripts;
    const oldSettings = settingsChanged ? { ...store.DEFAULT_SETTINGS, ...(changes.settings.oldValue || {}) } : now.settings;
    await applyCssChanges(oldScripts, now.scripts, oldSettings, now.settings);
    await reloadDisabledTabs(oldScripts, now.scripts, oldSettings, now.settings);
    if (settingsChanged) {
      const o = oldSettings;
      const n = now.settings;
      if (o.enabled !== n.enabled || o.showBadge !== n.showBadge || JSON.stringify(o.disabledHosts) !== JSON.stringify(n.disabledHosts)) {
        await updateAllBadges();
      }
    }
    if (scriptsChanged && now.settings.autoReinjectOnSave) {
      // Hot reload: re-run JS scripts whose code/config changed in open tabs.
      const oldMap = new Map(oldScripts.map((s) => [s.id, s]));
      for (const s of now.scripts) {
        const o = oldMap.get(s.id);
        if (s.type !== 'js' || !s.enabled || !o || o.updatedAt === s.updatedAt) continue;
        if (o.code === s.code && JSON.stringify(o.include) === JSON.stringify(s.include) && o.enabled === s.enabled) continue;
        await reinjectScriptEverywhere(s.id);
      }
    }
  })().catch((e) => console.error('[Script Injector]', e));
});

/* ======================================================================
 * Lifecycle
 * ==================================================================== */

chrome.runtime.onInstalled.addListener(async (details) => {
  await store.getToken();
  if (details.reason === 'install') {
    const existing = await store.getScripts();
    if (!existing.length && !(await control.isManaged())) await store.setScripts(store.sampleScripts()); // managed copies get only the admin's libraries
    await store.saveSettings({});
  }
  cache = null;
  scheduleSync();
  scheduleMenus();
  updateAllBadges();
  if (details.reason === 'install' && !userScriptsAvailable()) openDashboard('view=settings&welcome=1');
});

chrome.runtime.onStartup.addListener(() => {
  scheduleSync();
  scheduleMenus();
});

checkEngine();

// Online auto-sync: every 30s (the alarm survives service-worker restarts) + shortly after start
chrome.alarms.create('si-sync', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async (a) => { if (a.name === 'si-sync' && !(await control.blocked())) sync.syncNow().catch(() => {}); });
setTimeout(async () => { if (!(await control.blocked())) sync.syncNow().catch(() => {}); }, 3000);

// Script updates: scripts installed from a link are checked for a newer @version (default every 6 h, on by default).
// get() first: re-creating the alarm on every service-worker wake would keep pushing it back.
async function scheduleUpdates() {
  const st = await store.getSettings();
  const want = Math.max(1, Number(st.updateHours) || 6) * 60;
  const a = await chrome.alarms.get('si-update');
  if (!st.autoUpdate) { if (a) chrome.alarms.clear('si-update'); return; }
  if (!a || a.periodInMinutes !== want) chrome.alarms.create('si-update', { delayInMinutes: 2, periodInMinutes: want });
}
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== 'si-update') return;
  const st = await store.getSettings();
  if (!st.autoUpdate || (await control.blocked())) return;
  const r = await installer.checkUpdates({ auto: true }).catch((e) => ({ error: e.message, updated: [] }));
  if (r.updated && r.updated.length) {
    addLog({ level: 'info', kind: 'update', message: 'Updated: ' + r.updated.map((u) => u.name + ' v' + u.from + ' → v' + u.to).join(', '), time: Date.now() });
  }
});
chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.settings) scheduleUpdates().catch(() => {}); });
scheduleUpdates().catch(() => {});

// Remote control (control.json in the private repo): checked every checkMinutes, not on page loads.
async function scheduleControl() {
  if (!(await control.isManaged())) return chrome.alarms.clear('si-control');
  const st = await control.getState();
  const want = Math.max(5, Number(st && st.cfg && st.cfg.checkMinutes) || 15);
  const a = await chrome.alarms.get('si-control');
  if (!a || a.periodInMinutes !== want) chrome.alarms.create('si-control', { delayInMinutes: want, periodInMinutes: want });
  if (!st || !st.checkedAt || Date.now() - st.checkedAt > want * 60000) control.check().catch(() => {});
}
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'si-control') control.check().catch(() => {}); });
// While locked, a published script changed on this computer is put back (debounced; only when something was edited)
let restoreTimer = null;
function scheduleRestore() {
  clearTimeout(restoreTimer);
  restoreTimer = setTimeout(async () => {
    if (!(await control.isLocked())) return;
    if ((await store.getScripts()).some(installer.isEdited)) control.check().catch(() => {});
  }, 3000);
}
scheduleControl().catch(() => {});
// keep the shared team-config copy fresh for the pages (they never fetch the file themselves when this exists)
import('./lib/gh.js').then((m) => m.teamFile({ force: true })).catch(() => {});
setInterval(() => import('./lib/gh.js').then((m) => m.teamFile({ force: true })).catch(() => {}), 4 * 60000);

// Extension updates: manifest.json + CHANGELOG.md in the GitHub repo, checked every 6 h and shortly after start
// GitHub check every extCheckHours (0 = never). A newer version already on disk (scheduled updater) is applied by
// reloading the extension, but only while no AnyPricer tab is open (a reload would cut its scripts off mid-work);
// otherwise it applies when those tabs are closed or Chrome restarts.
async function scheduleExtUpdate() {
  const st = await store.getSettings();
  const h = Number.isFinite(+st.extCheckHours) ? +st.extCheckHours : 6;
  const a = await chrome.alarms.get('si-ext-update');
  if (!h) { if (a) chrome.alarms.clear('si-ext-update'); }
  else if (!a || a.periodInMinutes !== h * 60) chrome.alarms.create('si-ext-update', { delayInMinutes: 1, periodInMinutes: h * 60 });
  if (!(await chrome.alarms.get('si-ext-apply'))) chrome.alarms.create('si-ext-apply', { delayInMinutes: 2, periodInMinutes: 15 });
}
async function applyDiskUpdate(force = false) {
  const disk = await extUpdate.diskVersion();
  if (!disk || !extUpdate.newer(disk, extUpdate.current())) return { pending: false };
  const st = await store.getSettings();
  const busyTabs = await chrome.tabs.query({ url: ['*://anypricer.com/*', '*://*.anypricer.com/*'] }).catch(() => []);
  const dev = (await extUpdate.isDevCopy()) && !st.extDevTest; // developer copy: only when testing, or on request
  if (!force && dev) return { pending: true, version: disk, dev: true };
  if (!force && st.extSkip === disk) return { pending: true, version: disk, skipped: true }; // user chose "Skip this version"
  if (force || (st.extAutoApply !== false && !busyTabs.length)) { setTimeout(() => chrome.runtime.reload(), 300); return { pending: true, reloading: true, version: disk }; }
  return { pending: true, version: disk, waiting: busyTabs.length };
}
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'si-ext-update') extUpdate.check().catch(() => {});
  if (a.name === 'si-ext-apply') applyDiskUpdate().catch(() => {});
});
chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.settings) scheduleExtUpdate().catch(() => {}); });
scheduleExtUpdate().catch(() => {});
