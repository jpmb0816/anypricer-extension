// Extension self-update check: compares this copy's manifest version with manifest.json in the GitHub repo
// and reads the matching sections of CHANGELOG.md. Unpacked extensions can't replace their own files, so the
// user runs the "Update" shortcut the installer made, then presses Reload (chrome.runtime.reload re-reads the files).
// team-config.json (optional): "update": { "repo": "OWNER/REPO", "branch": "main", "token": "github_pat_…" }
// A private repo needs a read-only token (Contents: read) for that repo; github.token is used when it has access.
import { teamFile } from './gh.js';

const DEFAULT_REPO = 'jpmb0816/anypricer-extension';
const KEY = 'extUpdate';

export const current = () => chrome.runtime.getManifest().version;

export function newer(a, b) { // a > b
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

// the latest setup from GitHub Releases: running it updates this copy in place (same folder, team settings kept)
export async function setupUrl() {
  const c = await cfg();
  try { // the setup file name carries the version (ScriptInjector-Setup-1.0.7.exe): take it from the latest release
    const r = await fetch(`https://api.github.com/repos/${c.repo}/releases/latest`, { cache: 'no-store', headers: c.token ? { Authorization: 'Bearer ' + c.token } : {} });
    const a = r.ok && ((await r.json()).assets || []).find((x) => /^ScriptInjector-Setup.*\.exe$/i.test(x.name));
    if (a) return a.browser_download_url;
  } catch (_) { /* fall back to the release page */ }
  return `https://github.com/${c.repo}/releases/latest`;
}

async function cfg() {
  const f = (await teamFile().catch(() => ({}))) || {};
  const u = f.update || {};
  return { repo: u.repo || DEFAULT_REPO, branch: u.branch || 'main', token: u.token || (f.github && f.github.token) || '' };
}

async function getFile(c, file) {
  const url = `https://api.github.com/repos/${c.repo}/contents/${file}?ref=${encodeURIComponent(c.branch)}`;
  const headers = { Accept: 'application/vnd.github.raw' };
  if (c.token) headers.Authorization = 'Bearer ' + c.token;
  const r = await fetch(url, { headers, cache: 'no-store' });
  if (!r.ok) throw new Error(`${file}: HTTP ${r.status}` + (r.status === 404 && !c.token ? ' (private repo? add update.token to team-config.json)' : ''));
  return r.text();
}

// "## 1.2.0 - 2026-11-19" sections newer than `since`, up to and including `upto`
export function changesBetween(md, since, upto) {
  const out = [];
  let cur = null;
  for (const line of String(md).split(/\r?\n/)) {
    const m = line.match(/^##\s+v?(\d+(?:\.\d+)*)\s*(.*)$/);
    if (m) { cur = newer(m[1], since) && !newer(m[1], upto) ? { version: m[1], title: m[2].replace(/^[-–—\s]+/, ''), items: [] } : null; if (cur) out.push(cur); continue; }
    const it = line.match(/^\s*[-*]\s+(.*)$/);
    if (cur && it) cur.items.push(it[1]);
  }
  return out;
}

export async function check() {
  const c = await cfg();
  const prev = (await chrome.storage.local.get(KEY))[KEY] || {};
  const state = { checkedAt: Date.now(), current: current(), latest: prev.latest || null, changes: prev.changes || [], notified: prev.notified || null, error: null };
  try {
    const latest = JSON.parse(await getFile(c, 'manifest.json')).version;
    state.latest = latest;
    state.changes = [];
    if (newer(latest, current())) {
      try { state.changes = changesBetween(await getFile(c, 'CHANGELOG.md'), current(), latest); } catch { /* no changelog */ }
    }
  } catch (e) { state.error = e.message; }
  if (state.latest && newer(state.latest, current()) && state.notified !== state.latest) {
    state.notified = state.latest;
    const first = state.changes[0];
    chrome.notifications.create('ext-update', {
      type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: `Update available: v${state.latest}`,
      message: first && first.items.length ? first.items.slice(0, 3).join('\n') : 'Open the extension popup to see what changed.',
    });
  }
  await chrome.storage.local.set({ [KEY]: state });
  return state;
}

// Version of the files on disk right now (the scheduled updater replaces them; Chrome keeps running the old ones until reload)
export async function diskVersion() {
  try { const r = await fetch(chrome.runtime.getURL('manifest.json') + '?t=' + Date.now(), { cache: 'no-store' }); return (await r.json()).version || ''; } catch (_) { return ''; }
}
// Developer copy = loaded from a folder without the setup's install.json marker: never applies updates by itself
export async function isDevCopy() {
  try { const r = await fetch(chrome.runtime.getURL('install.json'), { cache: 'no-store' }); return !r.ok; } catch (_) { return true; }
}
export async function getState() {
  const s = (await chrome.storage.local.get(KEY))[KEY];
  if (!s) return null;
  return { ...s, current: current(), available: !!(s.latest && newer(s.latest, current())) };
}
