// Install scripts from URLs or local files, validate their required scripts, and keep them up to date.
// A source is one .js file (with a ==UserScript== header) or an index .json that lists several:
//   { "scripts": [ { "file": "anypricer-core.js" }, … ] }  or  [ "a.js", "https://…/b.js" ]  (paths relative to the index)
import * as store from './storage.js';
import { headersFor, toApiUrl, isFolderUrl, ghConfig } from './gh.js';

const MAX_BYTES = 3_000_000;
const UPDATES_KEY = 'updates'; // { [scriptId]: { checkedAt, latest, error, edited } } + _last: { at, updated: [...] }

export async function fetchText(url, opts = {}) {
  if (!/^https:\/\//i.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/i.test(url)) throw new Error('Only https:// links are supported');
  const r = await fetch(url, { cache: 'no-store', credentials: 'omit', headers: await headersFor(url, opts) });
  if (!r.ok) {
    const e = new Error(`HTTP ${r.status}`);
    e.status = r.status;
    e.rateLimited = r.status === 429 || r.headers.get('x-ratelimit-remaining') === '0';
    throw e;
  }
  const t = await r.text();
  if (t.length > MAX_BYTES) throw new Error('File too large');
  return t;
}

const fileOf = (url) => { try { return decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); } catch { return ''; } };

/** One script from its code. The URL it came from becomes the update source unless the header names one. */
export function fromCode(code, url = '', fileName = '') {
  const script = store.parseUserScript(code, fileName || fileOf(url));
  if (url && !script.sourceUrl) script.sourceUrl = url;
  return { script, url };
}

const isIndex = (url, text) => /\.json([?#]|$)/i.test(url) || /^\s*[[{]/.test(text);

/** URL → [{ script, url } | { url, name, error }] */
export async function loadSource(url) {
  url = toApiUrl(url.trim());
  if (isFolderUrl(url)) return loadFolder(url);
  const text = await fetchText(url);
  if (!isIndex(url, text)) return [fromCode(text, url)];
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Not a valid index (.json)'); }
  const entries = Array.isArray(data) ? data : Array.isArray(data.scripts) ? data.scripts : [];
  if (!entries.length) throw new Error('The index lists no scripts');
  return Promise.all(entries.map(async (e) => {
    const rel = typeof e === 'string' ? e : e.url || e.file;
    let u = '';
    try {
      u = new URL(rel, url).href;
      return fromCode(await fetchText(u), u);
    } catch (err) {
      return { url: u || String(rel), name: (e && e.name) || String(rel), error: err.message };
    }
  }));
}

/** Several URLs → one flat list (failures become error items) */
export async function loadSources(urls) {
  const out = [];
  for (const u of urls) {
    try { out.push(...(await loadSource(u))); } catch (err) { out.push({ url: u, name: fileOf(u) || u, error: err.message }); }
  }
  return out;
}

/** Script ids that form a cycle in the given set, or [] */
function cycleIn(scripts) {
  const by = new Map(scripts.map((s) => [s.id, s]));
  const state = new Map();
  let found = [];
  const walk = (id, path) => {
    if (found.length) return;
    if (state.get(id) === 1) { found = path.slice(path.indexOf(id)); return; }
    if (state.get(id) === 2 || !by.has(id)) return;
    state.set(id, 1);
    for (const d of by.get(id).dependsOn || []) walk(d, [...path, d]);
    state.set(id, 2);
  };
  for (const s of scripts) walk(s.id, [s.id]);
  return found;
}

/**
 * Checks each loaded item against what is installed:
 * status new | update | same | older | error, each required script found in the batch / installed / missing,
 * header problems, and dependency cycles. Items without @id match an installed script by update source.
 */
export function plan(items, installed) {
  const byId = new Map(installed.map((s) => [s.id, s]));
  const bySrc = new Map(installed.filter((s) => s.sourceUrl).map((s) => [s.sourceUrl, s]));
  const rows = items.map((it) => {
    if (it.error) return { ...it, status: 'error', problems: [it.error], deps: [] };
    const s = { ...it.script };
    let cur = byId.get(s.id);
    const noId = !s.meta || !s.meta.header || s.meta.problems.some((p) => p.startsWith('No @id'));
    if (!cur && noId && s.sourceUrl) {
      const m = bySrc.get(s.sourceUrl);
      if (m) { cur = m; s.id = m.id; }
    }
    const status = !cur ? 'new' : s.version > (cur.version || 0) ? 'update' : s.version === (cur.version || 0) ? 'same' : 'older';
    return { ...it, script: s, cur, status, problems: [...((s.meta && s.meta.problems) || [])], deps: [] };
  });
  const batch = new Map(rows.filter((r) => r.script).map((r) => [r.script.id, r]));
  const dupes = new Set(rows.filter((r) => r.script).map((r) => r.script.id).filter((id, i, a) => a.indexOf(id) !== i));
  for (const r of rows) {
    if (!r.script) continue;
    if (dupes.has(r.script.id)) r.problems.push(`Same @id "${r.script.id}" appears twice`);
    r.deps = r.script.dependsOn.map((id) => {
      const b = batch.get(id);
      const i = byId.get(id);
      return { id, name: (b && b.script.name) || (i && i.name) || id, where: b ? 'batch' : i ? 'installed' : 'missing' };
    });
  }
  const all = [...installed.filter((s) => !batch.has(s.id)), ...[...batch.values()].map((r) => r.script)];
  const cyc = cycleIn(all);
  if (cyc.length) for (const r of rows) if (r.script && cyc.includes(r.script.id)) r.problems.push('Circular requirement: ' + cyc.join(' → '));
  return rows;
}

/** Blocking problems: the script cannot be installed as is */
export function blockers(row, selectedIds, installedIds = new Set()) {
  if (row.status === 'error') return row.problems;
  const out = row.problems.filter((p) => /Circular|appears twice|must be letters|not a valid script id/.test(p));
  for (const d of row.deps) {
    if (d.where === 'missing') out.push(`Needs "${d.id}", which is not installed and not in this list`);
    else if (d.where === 'batch' && selectedIds && !selectedIds.has(d.id) && !installedIds.has(d.id)) out.push(`Needs "${d.name}" (in this list, but not selected)`);
  }
  return out;
}

const FROM_HEADER = ['name', 'description', 'code', 'version', 'exclude', 'runAt', 'world', 'dependsOn', 'requires', 'wrap', 'reloadOnDisable', 'keep', 'runOnSpa', 'allFrames', 'delay', 'captureConsole', 'type'];

/** Installed script + new copy → updated script (keeps id, on/off, auto-update choice) */
export function merge(cur, s) {
  const now = Date.now();
  const { meta, ...clean } = s;
  if (!cur) {
    const { startOff, ...rest } = clean;
    const n = store.normalizeScript({ ...rest, enabled: !startOff, createdAt: now, updatedAt: now });
    return { ...n, codeHash: store.integrity(n) };
  }
  const next = { ...cur };
  for (const k of FROM_HEADER) next[k] = clean[k];
  if (clean.include.length) next.include = clean.include;
  next.sourceUrl = clean.sourceUrl || cur.sourceUrl;
  next.origin = clean.sourceUrl ? '' : clean.origin || cur.origin;
  next.updatedAt = now;
  const n = store.normalizeScript(next);
  return { ...n, codeHash: store.integrity(n) };
}

/** Installs the chosen rows (required ones first). New scripts are turned on together with what they need. */
export async function install(rows) {
  let list = await store.getScripts();
  const added = [];
  for (const r of store.sortByDeps(rows.map((x) => x.script)).map((s) => rows.find((x) => x.script === s))) {
    const cur = list.find((x) => x.id === r.script.id);
    const next = merge(cur, r.script);
    if (cur) list = list.map((x) => (x.id === cur.id ? next : x));
    else { list.push(next); added.push(next.id); }
  }
  await store.setScripts(list);
  for (const id of added) await store.setEnabledWithDeps(id, true);
  const reqs = [...new Set(rows.flatMap((r) => r.script.requires))];
  if (reqs.length) await store.fetchRequires(reqs).catch(() => {});
  await clearState(rows.map((r) => r.script.id));
  return { added: added.length, updated: rows.length - added.length };
}

export async function getState() {
  return (await chrome.storage.local.get(UPDATES_KEY))[UPDATES_KEY] || {};
}
async function patchState(fn) {
  const st = await getState();
  fn(st);
  await chrome.storage.local.set({ [UPDATES_KEY]: st });
  return st;
}
const clearState = (ids) => patchState((st) => { for (const id of ids) delete st[id]; });

export const isEdited = (s) => !!s.codeHash && store.integrity(s) !== s.codeHash;

/**
 * Checks scripts that have an update source for a newer @version and installs it.
 * auto: only scripts with auto-update on (the periodic check). ids: only these. overwriteEdits: also replace
 * scripts edited locally (otherwise they are only marked "update available").
 * A newer version that needs a script that is not installed gets it from index.json next to the script, if there.
 */
/** Quick update of one script (popup / dashboard button): returns a short message for a toast */
/** Update all scripts of one library (popup / dashboard group button): short message for a toast */
export async function updateMany(ids) {
  if (!ids.length) return { ok: true, msg: 'No scripts from a link in this library' };
  const r = await checkUpdates({ ids });
  const up = r.updated || [];
  const errs = Object.values(r.state || {}).filter((x) => x && x.error).length;
  if (up.length) return { ok: true, msg: `Updated ${up.length}: ${up.map((u) => u.name).join(', ')}. Reload the page to run them.` };
  return errs ? { ok: false, msg: `Could not check ${errs} script(s)` } : { ok: true, msg: `All ${ids.length} up to date` };
}
export async function updateOne(id) {
  const r = await checkUpdates({ ids: [id] });
  const u = (r.updated || [])[0];
  if (u) return { ok: true, msg: `Updated: ${u.name}${u.from !== '?' ? ` v${u.from} → v${u.to}` : ''}. Reload the page to run it.` };
  const st = r.state && r.state[id];
  if (st && st.error) return { ok: false, msg: st.error };
  if (st && st.edited && st.latest) return { ok: false, msg: `v${st.latest} available, but you edited this script: use Check now in the editor to replace your edits` };
  return { ok: true, msg: 'Already up to date' };
}
export async function checkUpdates({ ids = null, auto = false, overwriteEdits = false } = {}) {
  // Signed managed copy: updates only come through the signed libraries (control check), never straight from a link
  const g = await ghConfig();
  if (g && g.publicKey) {
    const r = await (await import('./control.js')).check();
    const st = await getState();
    st._last = { at: Date.now(), checked: 0, updated: [] };
    return { checked: 0, updated: [...(r.installed || [])].map((name) => ({ name, from: '?', to: 'new' })), state: st, viaControl: r };
  }
  const scripts = await store.getScripts();
  const targets = scripts.filter((s) => s.sourceUrl && (ids ? ids.includes(s.id) : !auto || s.autoUpdate));
  const now = Date.now();
  const res = await Promise.all(targets.map(async (s) => {
    try { return { s, n: fromCode(await fetchText(s.sourceUrl), s.sourceUrl).script }; } catch (e) { return { s, error: e.message }; }
  }));
  let list = scripts.slice();
  const st = await getState();
  const updated = [];
  const indexCache = new Map();
  for (const r of res) {
    const { s } = r;
    if (r.error) { st[s.id] = { checkedAt: now, error: r.error }; continue; }
    const n = { ...r.n, id: s.id };
    if (n.version <= s.version) { st[s.id] = { checkedAt: now, latest: n.version }; continue; }
    if (isEdited(s) && !overwriteEdits) { st[s.id] = { checkedAt: now, latest: n.version, edited: true }; continue; }
    const missing = n.dependsOn.filter((id) => !list.some((x) => x.id === id));
    if (missing.length) {
      const idxUrl = new URL('index.json', s.sourceUrl).href;
      if (!indexCache.has(idxUrl)) indexCache.set(idxUrl, await loadSource(idxUrl).catch(() => []));
      for (const id of missing) {
        const it = indexCache.get(idxUrl).find((x) => x.script && x.script.id === id);
        if (it) { list.push(merge(null, it.script)); updated.push({ id, name: it.script.name, from: 0, to: it.script.version, added: true }); }
      }
      const still = n.dependsOn.filter((id) => !list.some((x) => x.id === id));
      if (still.length) { st[s.id] = { checkedAt: now, latest: n.version, error: `v${n.version} needs ${still.join(', ')} (not found)` }; continue; }
    }
    list = list.map((x) => (x.id === s.id ? merge(x, n) : x));
    updated.push({ id: s.id, name: n.name, from: s.version, to: n.version });
    st[s.id] = { checkedAt: now, latest: n.version };
  }
  st._last = { at: now, checked: targets.length, updated };
  if (updated.length) {
    await store.setScripts(list);
    const reqs = [...new Set(list.filter((x) => updated.some((u) => u.id === x.id)).flatMap((x) => x.requires))];
    if (reqs.length) await store.fetchRequires(reqs).catch(() => {});
  }
  await chrome.storage.local.set({ [UPDATES_KEY]: st });
  return { checked: targets.length, updated, state: st };
}

/** A GitHub folder (public, or private with the team token) → every .js file in it */
async function loadFolder(url) {
  const data = JSON.parse(await fetchText(url, { listing: true }));
  if (!Array.isArray(data)) {
    if (data && data.type === 'file') return loadSource(data.url);
    throw new Error('Not a GitHub folder');
  }
  const js = data.filter((e) => e.type === 'file' && /\.js$/i.test(e.name));
  if (!js.length) throw new Error('No .js files in this folder');
  return Promise.all(js.map(async (e) => {
    const u = e.url; // API link (keeps ?ref=branch) → stable update source, works for private repos too
    try { return fromCode(await fetchText(u), u); } catch (err) { return { url: u, name: e.name, error: err.message }; }
  }));
}
