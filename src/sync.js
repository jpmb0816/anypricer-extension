// Online auto-sync of per-script data (sdata:<scriptId>:<key>) with Supabase (PostgREST API).
// Local data stays the source of truth (works offline); changes go to an outbox that is pushed
// automatically, and newer rows from other devices are pulled back in.
//
// Config (first match wins):
//   1. Settings → Online database (chrome.storage.local "syncConfig")
//   2. team-config.json in the extension folder (so coworkers need no setup)
//   { "supabaseUrl": "https://xxxx.supabase.co", "anonKey": "...", "teamToken": "...", "enabled": true }

const OUTBOX = 'sync:outbox';   // { storageKey: changedAtMs }
const CURSOR = 'sync:cursor';   // ISO timestamp of the newest row pulled
const STATUS = 'sync:status';   // shown in Settings / Data
const DEVICE = 'sync:device';   // { id, name }
const CFG = 'syncConfig';
const PUSH_BATCH = 100;
const PULL_PAGE = 500;

const fromSync = new Map();     // storage key → JSON of the value a pull wrote (that exact value is never pushed back)
const jsonOrDel = (v) => { if (v === undefined) return '(deleted)'; try { return JSON.stringify(v); } catch (_) { return ''; } };
let pushTimer = null;

function serial() {
  let chain = Promise.resolve();
  return (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
}
const runSerial = serial();
const outboxSerial = serial();

export async function getConfig() {
  const manual = (await chrome.storage.local.get(CFG))[CFG] || null;
  let file = null;
  try {
    const r = await fetch(chrome.runtime.getURL('team-config.json'), { cache: 'no-store' });
    if (r.ok) file = await r.json();
  } catch (_) { /* no team-config.json */ }
  let c = null;
  if (manual && manual.supabaseUrl) c = { ...(file || {}), ...manual, source: 'Settings' };
  else if (file && file.supabaseUrl) c = { ...file, source: 'team-config.json' };
  if (!c || !c.supabaseUrl || !c.anonKey || !c.teamToken) return null;
  c.supabaseUrl = String(c.supabaseUrl).trim().replace(/\/+$/, '');
  c.enabled = c.enabled !== false;
  return c;
}

export async function getDevice() {
  let d = (await chrome.storage.local.get(DEVICE))[DEVICE];
  if (!d || !d.id) {
    d = { id: crypto.randomUUID(), name: 'PC-' + Math.random().toString(16).slice(2, 6) };
    await chrome.storage.local.set({ [DEVICE]: d });
  }
  return d;
}

async function setStatus(patch) {
  const cur = (await chrome.storage.local.get(STATUS))[STATUS] || {};
  await chrome.storage.local.set({ [STATUS]: { ...cur, ...patch, updated: Date.now() } });
}

const headers = (c, extra = {}) => ({
  apikey: c.anonKey,
  ...(String(c.anonKey).startsWith('eyJ') ? { Authorization: 'Bearer ' + c.anonKey } : {}), // legacy JWT anon key only; new sb_publishable_ keys go in apikey alone
  'x-team-token': c.teamToken,
  'Content-Type': 'application/json',
  ...extra
});

async function api(c, path, opts = {}) {
  const res = await fetch(c.supabaseUrl + '/rest/v1/' + path, { ...opts, headers: headers(c, opts.headers) });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`HTTP ${res.status}${body ? ': ' + body : ''}`);
  }
  return res;
}

// keys starting with "local:" stay on this computer (never uploaded), e.g. big caches a script can reload itself
const parseKey = (k) => { const m = /^sdata:([^:]+):(?!local:)(.*)$/.exec(k); return m ? { scriptId: m[1], key: m[2] } : null; };

/** Called for every sdata:* storage change. Queues it for upload unless it came from a pull. */
export async function noteChange(storageKey, newValue) {
  if (!parseKey(storageKey)) return;
  if (fromSync.has(storageKey)) {
    const pulled = fromSync.get(storageKey);
    fromSync.delete(storageKey);
    if (pulled === jsonOrDel(newValue)) return; // the pull's own write: don't echo it back
  }
  await outboxSerial(async () => {
    const ob = (await chrome.storage.local.get(OUTBOX))[OUTBOX] || {};
    ob[storageKey] = Date.now();
    await chrome.storage.local.set({ [OUTBOX]: ob });
  });
  schedulePush();
}

export function schedulePush(delay = 3000) {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => syncNow({ pullToo: false }).catch(() => {}), delay);
}

async function push(c, dev) {
  let pushed = 0;
  for (;;) {
    const ob = (await chrome.storage.local.get(OUTBOX))[OUTBOX] || {};
    const keys = Object.keys(ob).slice(0, PUSH_BATCH);
    if (!keys.length) break;
    const vals = await chrome.storage.local.get(keys);
    const rows = keys.map((k) => {
      const p = parseKey(k);
      const present = Object.prototype.hasOwnProperty.call(vals, k);
      return {
        script_id: p.scriptId,
        key: p.key,
        value: present ? vals[k] : null,
        deleted: !present,               // removed locally → tombstone (deletes are soft online)
        updated_at: new Date(ob[k]).toISOString(),
        updated_by: dev.id,
        device_name: dev.name
      };
    });
    await api(c, 'script_data?on_conflict=script_id,key', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows)
    });
    // Drop only entries that did not change again while uploading
    await outboxSerial(async () => {
      const cur = (await chrome.storage.local.get(OUTBOX))[OUTBOX] || {};
      for (const k of keys) if (cur[k] === ob[k]) delete cur[k];
      await chrome.storage.local.set({ [OUTBOX]: cur });
    });
    pushed += rows.length;
  }
  return pushed;
}

async function pull(c, dev) {
  let pulled = 0;
  for (;;) {
    const cursor = (await chrome.storage.local.get(CURSOR))[CURSOR] || '1970-01-01T00:00:00Z';
    const res = await api(c, `script_data?select=script_id,key,value,deleted,updated_at,updated_by,device_name&updated_at=gt.${encodeURIComponent(cursor)}&order=updated_at.asc&limit=${PULL_PAGE}`);
    const rows = await res.json();
    if (!rows.length) break;
    const ob = (await chrome.storage.local.get(OUTBOX))[OUTBOX] || {};
    for (const r of rows) {
      if (r.updated_by === dev.id) continue; // our own upload
      const sk = `sdata:${r.script_id}:${r.key}`;
      if (ob[sk]) continue; // we have a newer local change waiting to upload
      const ix = `sidx:${r.script_id}`;
      const idx = (await chrome.storage.local.get(ix))[ix] || {};
      const remoteT = Date.parse(r.updated_at);
      if (idx[r.key] && idx[r.key].updated > remoteT) continue; // local copy is newer
      fromSync.set(sk, jsonOrDel(r.deleted ? undefined : r.value));
      if (r.deleted) {
        delete idx[r.key];
        await chrome.storage.local.remove(sk);
      } else {
        let size = 0;
        try { size = JSON.stringify(r.value).length; } catch (_) { /* ignore */ }
        idx[r.key] = { updated: remoteT, size, from: 'sync', by: r.device_name || '' };
        await chrome.storage.local.set({ [sk]: r.value });
      }
      await chrome.storage.local.set({ [ix]: idx });
      pulled++;
    }
    await chrome.storage.local.set({ [CURSOR]: rows[rows.length - 1].updated_at });
    if (rows.length < PULL_PAGE) break;
  }
  return pulled;
}

/** Push pending changes, then (optionally) pull newer rows from other devices. */
export function syncNow({ pullToo = true } = {}) {
  return runSerial(async () => {
    const c = await getConfig();
    const pending = Object.keys((await chrome.storage.local.get(OUTBOX))[OUTBOX] || {}).length;
    if (!c) { await setStatus({ state: 'off', pending, error: '' }); return { state: 'off' }; }
    if (!c.enabled) { await setStatus({ state: 'paused', pending, source: c.source, error: '' }); return { state: 'paused' }; }
    const dev = await getDevice();
    try {
      // First time this database is used on this computer: upload everything already stored locally
      const INIT = 'sync:initFor';
      if ((await chrome.storage.local.get(INIT))[INIT] !== c.supabaseUrl) {
        const all = await chrome.storage.local.get(null);
        const now = Date.now();
        await outboxSerial(async () => {
          const ob = (await chrome.storage.local.get(OUTBOX))[OUTBOX] || {};
          for (const k of Object.keys(all)) if (k.startsWith('sdata:') && !ob[k]) ob[k] = (all['sidx:' + parseKey(k).scriptId] || {})[parseKey(k).key]?.updated || now;
          await chrome.storage.local.set({ [OUTBOX]: ob, [INIT]: c.supabaseUrl, [CURSOR]: '1970-01-01T00:00:00Z' });
        });
      }
      const pushed = await push(c, dev);
      const pulled = pullToo ? await pull(c, dev) : 0;
      const left = Object.keys((await chrome.storage.local.get(OUTBOX))[OUTBOX] || {}).length;
      const now = Date.now();
      const patch = { state: 'ok', error: '', source: c.source, url: c.supabaseUrl, device: dev.name, pending: left, lastSync: now };
      if (pushed) { patch.lastPush = now; patch.lastPushed = pushed; }
      if (pullToo) { patch.lastPull = now; if (pulled) patch.lastPulled = pulled; }
      await setStatus(patch);
      return { state: 'ok', pushed, pulled, pending: left };
    } catch (e) {
      const left = Object.keys((await chrome.storage.local.get(OUTBOX))[OUTBOX] || {}).length;
      await setStatus({ state: 'error', error: e.message, source: c.source, url: c.supabaseUrl, device: dev.name, pending: left, lastError: Date.now() });
      return { state: 'error', error: e.message };
    }
  });
}

/** Checks the URL / keys / team token without changing anything. */
export async function testConnection() {
  const c = await getConfig();
  if (!c) return { ok: false, error: 'No online database configured (Settings or team-config.json).' };
  try {
    const res = await api(c, 'script_data?select=key&limit=1');
    await res.json();
    // A wrong team token returns an empty list (no error) because of row-level security: check it is accepted
    const probe = await api(c, 'rpc/team_ok', { method: 'POST', body: '{}' });
    const ok = await probe.json();
    if (ok !== true) return { ok: false, error: 'Connected, but the team token was not accepted.' };
    return { ok: true, source: c.source };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Queue every existing script value for upload (first connection / re-upload). */
export async function queueAll() {
  const all = await chrome.storage.local.get(null);
  const now = Date.now();
  await outboxSerial(async () => {
    const ob = (await chrome.storage.local.get(OUTBOX))[OUTBOX] || {};
    for (const k of Object.keys(all)) if (k.startsWith('sdata:') && !ob[k]) ob[k] = now;
    await chrome.storage.local.set({ [OUTBOX]: ob });
  });
  schedulePush(500);
}

export async function getStatus() {
  const [st, c, dev] = [(await chrome.storage.local.get(STATUS))[STATUS] || {}, await getConfig(), await getDevice()];
  const pending = Object.keys((await chrome.storage.local.get(OUTBOX))[OUTBOX] || {}).length;
  return { ...st, pending, configured: !!c, enabled: c ? c.enabled : false, source: c ? c.source : '', url: c ? c.supabaseUrl : '', device: dev.name, deviceId: dev.id };
}
