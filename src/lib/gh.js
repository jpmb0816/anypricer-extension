// GitHub access for managed copies.
// team-config.json "github" (one of):
//   { "control": "https://raw.githubusercontent.com/OWNER/PUBLIC-REPO/main/control.json" }   ← recommended: no token on users' PCs
//   { "repo": "OWNER/REPO", "token": "github_pat_…" }   ← control.json in a private repo, read with a read-only token
//   optional "repos": ["OWNER/other-private-repo"]       ← more private repos that token may read
//   optional "publicKey": "…"  ← admin signing key (tools/sign.mjs): control.json, index.json and files must be signed / match
// Private library: control.json carries its token ENCRYPTED with the admin key; entering the key decrypts it on that
// computer only (stored as privateAccess). Tokens are only ever sent to the repo they belong to.
let cfgPromise = null;
let cfgAt = 0;
export const API = 'https://api.github.com/repos/';

// Read once per browser session (the background does it on start) and shared with the pages through
// storage.session, so pages don't request a file that may not exist (that logs a console error).
export async function teamFile({ force = false } = {}) {
  try {
    const s = force ? null : (await chrome.storage.session.get('teamFile')).teamFile;
    if (s && Date.now() - s.at < 5 * 60000) return s.data;
  } catch { /* no session storage here */ }
  let data = {};
  try {
    const r = await fetch(chrome.runtime.getURL('team-config.json'), { cache: 'no-store' }).catch(() => null);
    data = r && r.ok ? await r.json() : {};
    if (!Object.keys(data).length) { // public setup: the team code pasted in the setup (team-code.txt)
      const c = await fetch(chrome.runtime.getURL('team-code.txt'), { cache: 'no-store' }).catch(() => null);
      const code = c && c.ok ? (await c.text()).trim() : '';
      if (code.startsWith('SI1.')) { const b = code.slice(4).replace(/-/g, '+').replace(/_/g, '/'); data = JSON.parse(decodeURIComponent(escape(atob(b + '==='.slice((b.length + 3) % 4))))); }
    }
  } catch { /* none */ }
  try { await chrome.storage.session.set({ teamFile: { data, at: Date.now() } }); } catch { /* ignore */ }
  return data;
}

/** { controlUrl, defaultLibrary, token, privateBases } or null when this copy is not managed */
export function ghConfig() {
  if (!cfgPromise || Date.now() - cfgAt > 60000) {
    cfgAt = Date.now();
    cfgPromise = teamFile().then((f) => {
      const g = f && f.github;
      if (!g || !(g.control || g.repo || g.base)) return null;
      if (g.control) {
        const dir = g.control.replace(/[^/]*$/, '');
        return { controlUrl: g.control, defaultLibrary: dir + 'scripts/', token: g.token || '', privateBases: privBases(g, null), publicKey: g.publicKey || '' };
      }
      const base = g.base || `${API}${g.repo}/contents/`; // base: test override only
      return { controlUrl: base + 'control.json', defaultLibrary: base + 'scripts/', token: g.token || '', privateBases: privBases(g, base), publicKey: g.publicKey || '' };
    });
  }
  return cfgPromise;
}
const privBases = (g, base) => [...(base ? [base] : []), ...(Array.isArray(g.repos) ? g.repos : []).filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r)).map((r) => `${API}${r}/contents/`)];

/** GitHub web links → API links (public and private repos):
 *  github.com/o/r/tree/main/folder → …/contents/folder?ref=main · github.com/o/r/blob/main/a.js → …/contents/a.js?ref=main
 *  github.com/o/r → …/contents/ (repo root). raw.githubusercontent.com links stay as they are (no rate limit). */
export function toApiUrl(u) {
  let m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:tree|blob)\/([^/?#]+)\/?([^?#]*)/.exec(u);
  if (m) return `${API}${m[1]}/${m[2].replace(/\.git$/, '')}/contents/${m[4]}?ref=${m[3]}`;
  m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(u);
  if (m) return `${API}${m[1]}/${m[2]}/contents/`;
  return u;
}
export const isApiUrl = (u) => u.startsWith(API) || /\/repos\/[^/]+\/[^/]+\/contents\//.test(u);
/** API contents link that points at a folder (no file extension) */
export const isFolderUrl = (u) => isApiUrl(u) && !/\.[a-z0-9]+$/i.test(u.split('?')[0].replace(/\/$/, ''));

export async function privateAccess() {
  return (await chrome.storage.local.get('privateAccess')).privateAccess || null; // { tokens: { [repo contents root]: token }, at }
}

/** Headers for a URL: raw file content from the GitHub API; a token only for the repo it belongs to */
export async function headersFor(url, { listing = false } = {}) {
  const [g, pa] = await Promise.all([ghConfig(), privateAccess()]);
  const h = {};
  if (isApiUrl(url)) h.Accept = listing ? 'application/vnd.github+json' : 'application/vnd.github.raw';
  const own = pa && pa.tokens && Object.entries(pa.tokens).find(([base]) => url.startsWith(base));
  const saved = !own && Object.entries(await repoTokens()).find(([base]) => url.startsWith(base));
  if (own) h.Authorization = 'Bearer ' + own[1];
  else if (saved) h.Authorization = 'Bearer ' + saved[1];
  else if (g && g.token && g.privateBases.some((b) => url.startsWith(b))) h.Authorization = 'Bearer ' + g.token;
  return h;
}

// Tokens for other private repos, added in the Install dialog: { [repo contents root]: token }. Each is only sent to its repo.
export async function repoTokens() {
  return (await chrome.storage.local.get('repoTokens')).repoTokens || {};
}
/** "owner/repo" for a GitHub link (github.com / API), or '' */
export function repoOf(url) {
  const m = /^https:\/\/(?:api\.github\.com\/repos|github\.com)\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/|$)/.exec(url) || /\/repos\/([\w.-]+)\/([\w.-]+)\/contents\//.exec(url);
  return m ? m[1] + '/' + m[2] : '';
}
export async function saveRepoToken(repo, token) {
  const t = await repoTokens();
  if (token) t[`${API}${repo}/contents/`] = token; else delete t[`${API}${repo}/contents/`];
  await chrome.storage.local.set({ repoTokens: t });
}
