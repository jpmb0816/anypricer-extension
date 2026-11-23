export const RUN_AT = ['document_start', 'document_end', 'document_idle', 'manual'];
export const WORLDS = ['MAIN', 'USER_SCRIPT'];
export const TYPES = ['js', 'css'];

export const DEFAULT_SETTINGS = {
  enabled: true,
  disabledHosts: [],
  autoReinjectOnSave: false,
  notifyOnError: false,
  showBadge: true,
  statusStyle: 'auto', // page loading status: 'auto' (site toasts if available, else pill) | 'pill' | 'off'
  logConsole: true,
  maxLogs: 500,
  autoUpdate: true, // check installed-from-URL scripts for a newer @version
  updateHours: 6,
  extCheckHours: 6, // extension: check GitHub for a new version (0 = never)
  extDevTest: false, // developer copy: behave like an installed copy (to test auto-update)
  extSkip: '', // extension: a version the user chose to skip (no banner, no automatic switch)
  extAutoApply: true // extension: reload into a newer version once it is on disk (installed by the scheduled updater)
};

export function newId() {
  return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function toList(v) {
  return (Array.isArray(v) ? v : String(v || '').split('\n'))
    .map((x) => String(x).trim())
    .filter(Boolean);
}

export function defaultScript(overrides = {}) {
  const now = Date.now();
  return {
    id: newId(),
    name: 'New script',
    description: '',
    enabled: true,
    type: 'js',
    code: '',
    include: [],
    exclude: [],
    runAt: 'document_idle',
    world: 'MAIN',
    allFrames: false,
    wrap: true,
    captureConsole: true,
    delay: 0,
    runOnSpa: false,
    reloadOnDisable: false,
    requires: [],
    dependsOn: [], // ids of other scripts this one needs (enabled together, injected first)
    version: 0, // whole-number @version (shown as v1, v2 …); 0 = none
    sourceUrl: '', // where updates come from (@downloadURL / the URL it was installed from)
    autoUpdate: true,
    origin: '', // where a local install came from, e.g. 'folder:lib' (groups the script list)
    codeHash: '', // hash of the code as installed → detects local edits (auto-update then waits)
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

export function normalizeScript(s = {}) {
  const d = defaultScript();
  const out = { ...d, ...s };
  if (!/^[A-Za-z0-9]+$/.test(String(out.id || ''))) out.id = newId();
  out.name = String(out.name || 'Untitled').slice(0, 200);
  out.description = String(out.description || '');
  out.code = String(out.code || '');
  out.include = toList(out.include);
  out.exclude = toList(out.exclude);
  out.requires = toList(out.requires);
  out.dependsOn = [...new Set(toList(out.dependsOn).filter((x) => /^[A-Za-z0-9]+$/.test(x) && x !== out.id))];
  if (!RUN_AT.includes(out.runAt)) out.runAt = d.runAt;
  if (!WORLDS.includes(out.world)) out.world = d.world;
  if (!TYPES.includes(out.type)) out.type = d.type;
  out.enabled = !!out.enabled;
  out.allFrames = !!out.allFrames;
  out.wrap = !!out.wrap;
  out.captureConsole = !!out.captureConsole;
  out.runOnSpa = !!out.runOnSpa;
  out.reloadOnDisable = !!out.reloadOnDisable;
  out.delay = Math.max(0, Math.min(600000, parseInt(out.delay, 10) || 0));
  out.version = parseVersion(out.version);
  out.sourceUrl = /^https?:\/\//i.test(String(out.sourceUrl || '')) ? String(out.sourceUrl).trim() : '';
  out.autoUpdate = out.autoUpdate !== false;
  out.codeHash = String(out.codeHash || '');
  out.origin = String(out.origin || '').slice(0, 200);
  return out;
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export async function getScripts() {
  const { scripts } = await chrome.storage.local.get('scripts');
  return (scripts || []).map(normalizeScript);
}

export async function setScripts(list) {
  await chrome.storage.local.set({ scripts: list.map(normalizeScript) });
}

export async function upsertScript(script) {
  const list = await getScripts();
  const s = normalizeScript({ ...script, updatedAt: Date.now() });
  const i = list.findIndex((x) => x.id === s.id);
  if (i >= 0) list[i] = s; else list.push(s);
  await setScripts(list);
  return s;
}

/* ---------- script dependencies (dependsOn) ---------- */
// All scripts a script needs, recursively (cycles ignored)
export function depClosure(id, scripts) {
  const seen = new Set();
  const walk = (x) => {
    const s = scripts.find((y) => y.id === x);
    for (const d of (s && s.dependsOn) || []) if (d !== id && !seen.has(d)) { seen.add(d); walk(d); }
  };
  walk(id);
  return seen;
}
// Scripts that (directly or indirectly) need this one
export function dependents(id, scripts) {
  return scripts.filter((s) => s.id !== id && depClosure(s.id, scripts).has(id));
}
// Required scripts that are missing or turned off → this script must not run
export function depProblems(s, scripts) {
  return [...depClosure(s.id, scripts)].map((id) => {
    const d = scripts.find((x) => x.id === id);
    return !d ? { id, name: id, problem: 'missing' } : !d.enabled ? { id, name: d.name, problem: 'off' } : null;
  }).filter(Boolean);
}
export const depsBlocked = (s, scripts) => depProblems(s, scripts).length > 0;
// Required scripts first (stable otherwise)
export function sortByDeps(scripts) {
  const out = [];
  const done = new Set();
  const visit = (s, stack = new Set()) => {
    if (done.has(s.id) || stack.has(s.id)) return;
    stack.add(s.id);
    for (const d of s.dependsOn || []) { const ds = scripts.find((x) => x.id === d); if (ds) visit(ds, stack); }
    done.add(s.id);
    out.push(s);
  };
  scripts.forEach((s) => visit(s));
  return out;
}
// Turn a script on together with everything it needs, or off together with everything that needs it.
// Returns the names of the OTHER scripts that were switched too.
export async function setEnabledWithDeps(id, enabled) {
  const list = await getScripts();
  const ids = new Set([id, ...(enabled ? depClosure(id, list) : dependents(id, list).map((s) => s.id))]);
  const also = [];
  const now = Date.now();
  const next = list.map((s) => {
    if (!ids.has(s.id) || s.enabled === enabled) return s;
    if (s.id !== id) also.push(s.name);
    return normalizeScript({ ...s, enabled, updatedAt: now });
  });
  await setScripts(next);
  return { also };
}

export async function patchScript(id, patch) {
  const list = await getScripts();
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) return null;
  list[i] = normalizeScript({ ...list[i], ...patch, updatedAt: Date.now() });
  await setScripts(list);
  return list[i];
}

export async function deleteScript(id) {
  const list = await getScripts();
  await setScripts(list.filter((x) => x.id !== id));
}

export async function getToken() {
  const { token } = await chrome.storage.local.get('token');
  if (token) return token;
  const t = crypto.randomUUID();
  await chrome.storage.local.set({ token: t });
  return t;
}

/* ---------- @require cache ---------- */

const reqKey = (url) => 'req:' + url;

export async function getRequireCache(urls) {
  if (!urls || !urls.length) return {};
  const data = await chrome.storage.local.get(urls.map(reqKey));
  const out = {};
  for (const u of urls) if (data[reqKey(u)]) out[u] = data[reqKey(u)];
  return out;
}

/** Fetches @require URLs (missing ones only unless force). Returns {errors:[]} */
export async function fetchRequires(urls, force = false) {
  const errors = [];
  const cache = force ? {} : await getRequireCache(urls);
  for (const url of urls) {
    if (cache[url]) continue;
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const code = await res.text();
      await chrome.storage.local.set({ [reqKey(url)]: { code, fetchedAt: Date.now(), size: code.length } });
    } catch (e) {
      errors.push(`${url}: ${e.message}`);
    }
  }
  return { errors };
}

/* ---------- logs & stats ---------- */

export async function getLogs() {
  const { logs } = await chrome.storage.local.get('logs');
  return logs || [];
}

export async function clearLogs(filter) {
  if (!filter) {
    await chrome.storage.local.set({ logs: [] });
    return;
  }
  const logs = await getLogs();
  await chrome.storage.local.set({ logs: logs.filter((l) => !filter(l)) });
}

export async function getStats() {
  const { stats } = await chrome.storage.local.get('stats');
  return stats || {};
}

/* ---------- helpers ---------- */

export function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export function isInjectableUrl(url) {
  if (!/^(https?|file|ftp):/i.test(url || '')) return false;
  // Pages Chrome never allows extensions to script.
  return !/^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i.test(url);
}

/** "v3" / "3" / 3 → 3; anything else → 0 */
export function parseVersion(v) {
  const m = /^\s*v?(\d{1,6})\b/i.exec(String(v ?? ''));
  return m ? parseInt(m[1], 10) : 0;
}
export const vLabel = (v) => (v ? 'v' + v : '');

/** Fingerprint of everything the publisher controls (code + run settings): any local change shows up */
export const integrity = (s) => hashCode(JSON.stringify([s.code, s.include, s.exclude, s.runAt, s.world, s.dependsOn, s.requires, !!s.wrap, s.type, s.delay | 0, !!s.allFrames]));

/** Short stable hash (FNV-1a) of a string, to notice local edits */
export function hashCode(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

/**
 * Parses a Tampermonkey/Greasemonkey style ==UserScript== header. Extra keys understood here:
 * @id (stable id, so updates replace the same script), @version (whole number: 1, 2 … or v1, v2 …),
 * @depends (required script ids), @downloadURL / @updateURL (update source), @reload-on-disable,
 * @run-on-spa, @all-frames, @delay ms, @nowrap, @no-console. s.meta.problems lists what is wrong/missing.
 */
export function parseUserScript(code, fileName = '') {
  const meta = /\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/.exec(code);
  const s = defaultScript({ code, name: fileName.replace(/(\.user)?\.js$/i, '') || 'Imported script' });
  const problems = [];
  if (!meta) {
    s.meta = { header: false, problems: ['No ==UserScript== header (name, version and pages unknown)'] };
    return s;
  }
  const include = [];
  const exclude = [];
  const requires = [];
  const deps = [];
  let rawVersion = null;
  let hasId = false;
  for (const line of meta[1].split('\n')) {
    const m = /^\s*\/\/\s*@([\w:-]+)\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const [, key, val] = m;
    switch (key) {
      case 'name': s.name = val; break;
      case 'id':
        if (/^[A-Za-z0-9]+$/.test(val)) { s.id = val; hasId = true; } else problems.push(`@id "${val}" must be letters/numbers only`);
        break;
      case 'version': rawVersion = val; break;
      case 'enabled': s.startOff = /^(false|no|off|0)$/i.test(val); break; // @enabled false → installed turned off (first install only)
      case 'description': s.description = val; break;
      case 'match':
      case 'include': include.push(val); break;
      case 'exclude':
      case 'exclude-match': exclude.push(val); break;
      case 'require': requires.push(val); break;
      case 'depends':
      case 'requires-script': deps.push(...val.split(/[\s,]+/).filter(Boolean)); break;
      case 'downloadURL':
      case 'updateURL':
        if (/^https?:\/\//i.test(val) && (key === 'downloadURL' || !s.sourceUrl)) s.sourceUrl = val;
        break;
      case 'reload-on-disable': s.reloadOnDisable = true; break;
      case 'run-on-spa': s.runOnSpa = true; break;
      case 'all-frames': s.allFrames = true; break;
      case 'delay': s.delay = parseInt(val, 10) || 0; break;
      case 'nowrap': s.wrap = false; break;
      case 'no-console': s.captureConsole = false; break;
      case 'run-at':
        s.runAt = { 'document-start': 'document_start', 'document-end': 'document_end', 'document-idle': 'document_idle', 'context-menu': 'manual' }[val] || s.runAt;
        break;
      case 'inject-into':
        s.world = val === 'content' ? 'USER_SCRIPT' : 'MAIN';
        break;
      default: break;
    }
  }
  s.include = include;
  s.exclude = exclude;
  s.requires = requires;
  s.dependsOn = [...new Set(deps)];
  s.version = parseVersion(rawVersion);
  if (rawVersion == null) problems.push('No @version');
  else if (!/^v?\d+$/i.test(rawVersion)) problems.push(`@version "${rawVersion}" should be a whole number (1, 2, 3 …)`);
  if (!include.length && s.runAt !== 'manual') problems.push('No @match: it will not run on any page');
  for (const d of s.dependsOn) if (!/^[A-Za-z0-9]+$/.test(d)) problems.push(`@depends "${d}" is not a valid script id`);
  if (!hasId) problems.push('No @id: installing again makes a copy instead of updating');
  s.meta = { header: true, problems };
  return s;
}

export function sampleScripts() {
  return [
    defaultScript({
      name: 'Example: hello banner',
      description: 'Shows a small banner on example.com. Safe to delete.',
      include: ['*://example.com/*', '*://*.example.com/*'],
      code: [
        "const bar = document.createElement('div');",
        "bar.textContent = '👋 Injected by Script Injector (' + injector.trigger + ')';",
        "bar.style.cssText = 'position:fixed;bottom:16px;right:16px;padding:10px 14px;background:#4f46e5;color:#fff;font:14px system-ui;border-radius:8px;z-index:2147483647;box-shadow:0 4px 14px rgba(0,0,0,.25)';",
        'document.body.appendChild(bar);',
        "console.log('Banner injected on', location.href);"
      ].join('\n')
    }),
    defaultScript({
      name: 'Example: dark style',
      description: 'CSS example. Disabled by default.',
      type: 'css',
      enabled: false,
      runAt: 'document_start',
      include: ['*://example.com/*'],
      code: 'html { filter: invert(1) hue-rotate(180deg); }\nimg, video { filter: invert(1) hue-rotate(180deg); }'
    }),
    defaultScript({
      name: 'Example: outline all links (manual)',
      description: 'Manual script. Run it from the popup or right-click menu on any page.',
      runAt: 'manual',
      include: ['*'],
      code: [
        "const links = document.querySelectorAll('a');",
        "links.forEach((a) => (a.style.outline = '2px solid #f59e0b'));",
        "console.log('Outlined', links.length, 'links');"
      ].join('\n')
    })
  ];
}
