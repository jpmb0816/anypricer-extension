// Remote control from control.json (only when team-config.json has "github").
// Checked in the background every few minutes (never per page load); scripts always run from the local copy.
//   enabled:false        → everything stops (message shown in the popup / dashboard)
//   control.json gone / token revoked (401, 404, 403 not rate-limit) → stops right away
//   unreachable          → keeps working for offlineGraceHours, then stops
//   library              → what everyone installs: one entry or a list. Each entry is a folder (ends with "/":
//                          its index.json, or every .js in it) or a single .js file.
//   privateLibrary       → one or a list of { repo, path, enc }: used FIRST (plus library) on computers where the admin
//                          key was entered. Each read-only token is encrypted with the key (tools/control.mjs private …),
//                          so nobody can read them without it. When access ends, private-only scripts are removed.
//   removeScripts / disableScripts, forceSettings, autoInstallNew
//   lock                 → key (PBKDF2 hash) needed to edit scripts / settings; local edits to library scripts are restored
import * as store from './storage.js';
import * as installer from './installer.js';
import { ghConfig, privateAccess, API, isFolderUrl, repoTokens } from './gh.js';

// A private library is connected on this PC when its own token was given (Settings → Libraries / Install),
// or (older way) the admin key decrypted it. The key itself is only for viewing code and editing.
async function hasAccess(root) {
  const [pa, rt] = await Promise.all([privateAccess(), repoTokens()]);
  return !!((pa && pa.tokens && pa.tokens[root]) || rt[root]);
}
import { verifySigned, sha256Text } from './verify.js';

const KEY = 'control'; // { cfg, lastOkAt, checkedAt, error, denied }
export const DEFAULTS = { enabled: true, message: '', checkMinutes: 15, offlineGraceHours: 72, autoInstallNew: true, library: '', privateLibrary: null, removeScripts: [], disableScripts: [], forceSettings: {}, lock: null };

export async function getState() {
  return (await chrome.storage.local.get(KEY))[KEY] || null;
}
export const isManaged = async () => !!(await ghConfig());

/** null = allowed; otherwise { reason } and nothing is injected */
export function blockReason(st) {
  if (st && st.denied) return { reason: 'Access removed by the admin.' };
  if (!st || !st.lastOkAt) return { reason: 'Waiting for the admin\'s settings (no connection yet).' };
  const cfg = { ...DEFAULTS, ...st.cfg };
  if (cfg.enabled === false) return { reason: cfg.message || 'Turned off by the admin.' };
  if (Date.now() - st.lastOkAt > cfg.offlineGraceHours * 3600e3) return { reason: `Could not reach the admin's settings for over ${cfg.offlineGraceHours} h.` };
  return null;
}
export async function blocked() {
  if (!(await isManaged())) return null;
  return blockReason(await getState());
}

// ---- libraries ----
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
/** private entries → { root (token scope = repo contents root), url (folder ending "/" or a .js file), enc } */
function privateLibs(cfg) {
  return list(cfg && cfg.privateLibrary).filter((p) => p && (p.repo || p.base)).map((p) => {
    const root = p.base || `${API}${p.repo}/contents/`; // base: test override only
    const path = String(p.path == null ? 'scripts/' : p.path).replace(/^\//, '');
    return { root, url: root + (path && !/\.js$/i.test(path) && !path.endsWith('/') ? path + '/' : path), enc: p.enc, sha256: p.sha256 };
  });
}
async function activeLibraries(cfg, g) {
  const pa = await privateAccess();
  const priv = [];
  for (const p of privateLibs(cfg)) if (await hasAccess(p.root)) priv.push(p);
  const pub = list(cfg.library).map((e) => (typeof e === 'string' ? { url: e } : e)).filter((e) => e && e.url);
  const team = pub.length ? pub : [{ url: g.defaultLibrary }];
  // Key entered: private libraries first (they win when both have the same script), then the team ones too
  if (priv.length) return { urls: [...priv.map((p) => ({ url: p.url, sha256: p.sha256, private: true })), ...team], private: true };
  return { urls: team, private: false };
}

/**
 * One library entry → candidates [{ id, version, url, item? }]. Folders use index.json (only changed files are
 * downloaded later); a folder without index.json and a single .js file are downloaded now (item = parsed script).
 */
async function candidates(entry, publicKey) {
  const url = entry.url;
  if (/\.js([?#]|$)/i.test(url)) {
    if (publicKey && !entry.sha256) throw new Error('Single file without sha256 in the signed control.json: ' + url);
    const c = toCand(await installer.loadSource(url))[0];
    if (!c) return [];
    if (publicKey && (await sha256Text(c.item.script.code)) !== entry.sha256) throw new Error('File does not match its signed hash: ' + url);
    return [c];
  }
  const dir = url.endsWith('/') ? url : url + '/';
  let idx;
  try {
    idx = JSON.parse(await installer.fetchText(dir + 'index.json'));
  } catch (e) {
    if (e.status !== 404 || !isFolderUrl(dir) || publicKey) throw e; // signed copies need a signed index.json
    return toCand(await installer.loadSource(dir));
  }
  if (publicKey) await verifySigned(idx, publicKey);
  return (idx.scripts || []).map((e) => ({ id: e.id, version: e.version, url: dir + e.file, sha256: e.sha256 }));
}
const toCand = (items) => items.filter((i) => i.script).map((i) => ({ id: i.script.id, version: i.script.version, url: i.url, item: i }));

// ---- key: lock + private library ----
export async function lockInfo() {
  if (!(await isManaged())) return null;
  const st = await getState();
  const cfg = (st && st.cfg) || {};
  const lock = cfg.lock;
  const pa = await privateAccess();
  const priv = privateLibs(cfg);
  let privateOn = false;
  for (const p of priv) if (await hasAccess(p.root)) privateOn = true;
  if (!lock || !lock.hash) return priv.length ? { locked: false, noLock: true, privateOn, privateLib: true } : null;
  const until = ((await chrome.storage.session.get('unlockedUntil')).unlockedUntil) || 0;
  return { locked: until < Date.now(), unlockedUntil: until, allowToggles: lock.allowToggles !== false, allowImport: lock.allowImport !== false, minutes: lock.unlockMinutes || 30, privateLib: priv.length > 0, privateOn };
}
export async function isLocked() {
  const l = await lockInfo();
  return !!(l && l.locked);
}
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s) => new Uint8Array(s.match(/../g).map((x) => parseInt(x, 16)));
const baseKey = (password) => crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits', 'deriveKey']);
async function pbkdf2(password, saltHex, iterations) {
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(saltHex), iterations }, await baseKey(password), 256));
}
async function decryptToken(password, enc) {
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(enc.salt), iterations: enc.iterations || 200000 }, await baseKey(password), { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unhex(enc.iv) }, key, unhex(enc.data)));
}

/** Admin key: unlocks editing for a while and (if set) switches this computer to the private libraries */
const FAILS = 'unlockFails'; // { n, until } → after 5 wrong keys, wait 1, 2, 4 … min (max 1 h)
export async function unlockWait() {
  const f = (await chrome.storage.local.get(FAILS))[FAILS];
  return f && f.until > Date.now() ? f.until - Date.now() : 0;
}
async function noteFail() {
  const f = (await chrome.storage.local.get(FAILS))[FAILS] || { n: 0, until: 0 };
  f.n++;
  if (f.n >= 5) f.until = Date.now() + Math.min(3600e3, 60e3 * 2 ** (f.n - 5));
  await chrome.storage.local.set({ [FAILS]: f });
}
export async function unlock(password) {
  if (await unlockWait()) return false;
  const ok2 = await unlockInner(password);
  if (ok2) await chrome.storage.local.remove(FAILS); else await noteFail();
  return ok2;
}
async function unlockInner(password) {
  const st = await getState();
  const cfg = (st && st.cfg) || {};
  const lock = cfg.lock;
  let ok = false;
  if (lock && lock.hash) {
    if ((await pbkdf2(password, lock.salt, lock.iterations || 200000)) !== lock.hash) return false;
    await chrome.storage.session.set({ unlockedUntil: Date.now() + (lock.unlockMinutes || 30) * 60000 });
    ok = true;
  }
  const tokens = {};
  for (const p of privateLibs(cfg)) {
    if (!p.enc) continue;
    try { tokens[p.root] = await decryptToken(password, p.enc); } catch { /* wrong key for this one */ }
  }
  if (Object.keys(tokens).length) {
    await chrome.storage.local.set({ privateAccess: { tokens, at: Date.now() } });
    check().catch(() => {});
    ok = true;
  }
  return ok;
}
export const relock = () => chrome.storage.session.set({ unlockedUntil: 0 });
export async function leavePrivate() {
  await chrome.storage.local.remove('privateAccess');
  const st = await getState();
  const rt = await repoTokens();
  for (const p of privateLibs((st && st.cfg) || {})) delete rt[p.root];
  await chrome.storage.local.set({ repoTokens: rt });
  return check();
}

// ---- check + apply ----
let running = null;
export function check() {
  if (!running) running = doCheck().finally(() => { running = null; });
  return running;
}
const isDenied = (e) => [401, 404].includes(e.status) || (e.status === 403 && !e.rateLimited);

async function doCheck() {
  const g = await ghConfig();
  if (!g) return { managed: false };
  const prev = (await getState()) || {};
  const now = Date.now();
  let cfg;
  try {
    // raw.githubusercontent.com caches ~5 min; a changing query gets the fresh file
    const u = g.controlUrl.includes('raw.githubusercontent.com') ? g.controlUrl + (g.controlUrl.includes('?') ? '&' : '?') + '_=' + Math.floor(now / 60000) : g.controlUrl;
    const raw = JSON.parse(await installer.fetchText(u));
    if (g.publicKey) await verifySigned(raw, g.publicKey); // forged / edited control.json is ignored (last good one stays)
    cfg = { ...DEFAULTS, ...raw };
  } catch (e) {
    const denied = isDenied(e);
    await chrome.storage.local.set({ [KEY]: { ...prev, checkedAt: now, error: e.message, denied } });
    return { managed: true, error: e.message, denied };
  }
  await chrome.storage.local.set({ [KEY]: { cfg, lastOkAt: now, checkedAt: now, error: '', denied: false } });
  if (cfg.enabled === false) return { managed: true, off: true };
  return { managed: true, ...(await apply(cfg, g)) };
}

async function gather(cfg, g, out, retried = false) {
  const libs = await activeLibraries(cfg, g);
  const cands = [];
  let failed = 0;
  let privFailed = 0;
  out.errors = [];
  for (const url of libs.urls) {
    try { cands.push(...(await candidates(url, g.publicKey))); } catch (e) {
      failed++;
      if (url.private) privFailed++;
      out.errors.push(e.message);
      if (url.private && isDenied(e)) { // that private token was revoked / repo gone → drop it
        const pa = await privateAccess();
        const root = privateLibs(cfg).find((p) => p.url === url.url)?.root;
        if (pa && root && pa.tokens[root]) { delete pa.tokens[root]; await chrome.storage.local.set({ privateAccess: pa }); }
        const rt = await repoTokens();
        if (root && rt[root]) { delete rt[root]; await chrome.storage.local.set({ repoTokens: rt }); }
        out.privateEnded = e.message;
      }
    }
  }
  // every private library failed → fall back to the public ones this time
  if (libs.private && privFailed === libs.urls.filter((u) => u.private).length && !retried) return gather(cfg, g, out, true);
  out.library = libs.private ? 'private' : 'public';
  return { libs, cands, complete: failed === 0 };
}

async function apply(cfg, g) {
  const out = { removed: [], disabled: [], installed: [], restored: [], library: '' };
  const remove = new Set(cfg.removeScripts || []);
  const disable = new Set(cfg.disableScripts || []);
  const privRoots = privateLibs(cfg).map((p) => p.root);
  const { libs, cands } = await gather(cfg, g, out);

  let scripts = await store.getScripts();
  const before = JSON.stringify(scripts.map((s) => [s.id, s.enabled]));
  scripts = scripts.filter((s) => {
    const gone = remove.has(s.id) || (!libs.private && privRoots.some((r) => s.sourceUrl.startsWith(r))); // private scripts leave with the access
    if (gone) out.removed.push(s.name);
    return !gone;
  });
  scripts = scripts.map((s) => { if (disable.has(s.id) && s.enabled) { out.disabled.push(s.name); return { ...s, enabled: false }; } return s; });
  if (JSON.stringify(scripts.map((s) => [s.id, s.enabled])) !== before) await store.setScripts(scripts);
  if (cfg.forceSettings && Object.keys(cfg.forceSettings).length) {
    const cur = await store.getSettings();
    if (Object.entries(cfg.forceSettings).some(([k, v]) => JSON.stringify(cur[k]) !== JSON.stringify(v))) await store.saveSettings(cfg.forceSettings);
  }
  if (!cands.length) return out;

  // Library scripts: new ones, newer versions, ones from another library, and (while locked) anything changed locally.
  // The first library that lists an id wins. Only the files that need it are downloaded.
  const settings = await store.getSettings();
  const locked = await isLocked();
  const byId = new Map(scripts.map((s) => [s.id, s]));
  const seen = new Set();
  const need = cands.filter((c) => {
    if (seen.has(c.id) || remove.has(c.id)) return false;
    seen.add(c.id);
    const cur = byId.get(c.id);
    if (!cur) return cfg.autoInstallNew !== false;
    const edited = installer.isEdited(cur);
    if (edited && !locked) return false; // unlocked: local edits are kept
    if (edited || cur.sourceUrl !== c.url) return true;
    return c.version > cur.version && settings.autoUpdate !== false && cur.autoUpdate !== false;
  });
  if (!need.length) return out;
  const items = await Promise.all(need.map(async (c) => {
    try {
      const it = c.item || installer.fromCode(await installer.fetchText(c.url), c.url);
      if (g.publicKey && c.sha256 !== undefined && (await sha256Text(it.script.code)) !== c.sha256) throw new Error('does not match its signed hash');
      if (g.publicKey && c.sha256 === undefined && !c.item) throw new Error('no signed hash');
      return it;
    } catch (err) { out.errors.push(c.url + ': ' + err.message); return { url: c.url, error: err.message }; }
  }));
  const rows = installer.plan(items.filter((i) => !i.error), scripts).map((r) => ({ ...r, script: { ...r.script, sourceUrl: r.url } }));
  if (!rows.length) return out;
  for (const r of rows) (!r.cur || r.status === 'update' ? out.installed : out.restored).push(r.script.name);
  await installer.install(rows);
  for (const r of rows) if (!r.cur && disable.has(r.script.id)) await store.setEnabledWithDeps(r.script.id, false);
  return out;
}
