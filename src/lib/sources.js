// Where a script comes from: a GitHub repo, a web folder (several scripts from one place), a single link,
// a local folder it was imported from, or this computer. Shared by the dashboard and the popup.
export const SOURCE_ORDER = { repo: 0, folder: 1, link: 2, localdir: 3, local: 4 };

/** s = script, all = every installed script (to tell a web folder from a single link) */
export function sourceGroup(s, all = []) {
  const u = s.sourceUrl || '';
  if (!u && s.origin.startsWith('folder:')) { const n = s.origin.slice(7); return { key: 'local:' + n, kind: 'localdir', icon: 'folderOpen', tag: 'Local folder', label: n, title: 'Installed from the folder "' + n + '" on this computer (no update link)' }; }
  if (!u) return { key: 'local', kind: 'local', icon: 'monitor', tag: 'This computer', label: 'Created or added here', title: 'Made here or installed from files on this computer (no update link)' };
  const m = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\//.exec(u) || /^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\//.exec(u) || /^https:\/\/github\.com\/([^/]+\/[^/]+)\//.exec(u) || /\/repos\/([^/]+\/[^/]+)\/contents\//.exec(u);
  if (m) return { key: 'repo:' + m[1], kind: 'repo', icon: 'github', tag: 'GitHub', label: m[1].split('/')[1], title: 'GitHub repo ' + m[1] };
  const dir = u.replace(/[^/]*([?#].*)?$/, '');
  const same = all.filter((x) => x.sourceUrl && x.sourceUrl.startsWith(dir) && !x.sourceUrl.slice(dir.length).includes('/')).length;
  if (same > 1) { let label = dir; try { const x = new URL(dir); label = x.host + x.pathname; } catch { /* keep */ } return { key: 'dir:' + dir, kind: 'folder', icon: 'folder', tag: 'Web folder', label, title: dir }; }
  return { key: 'links', kind: 'link', icon: 'link', tag: 'Link', label: 'Single links', title: 'Each installed from its own link' };
}

import * as control from './control.js';
import { ghConfig, repoTokens, privateAccess, repoOf } from './gh.js';

/**
 * Repos this copy knows: { 'repo:owner/name': 'team' | 'private' } and the private repos not connected on this PC.
 * team = the managed library (for everyone); private = a private library or a repo connected with its own token.
 */
export async function repoStatus() {
  const kinds = {};
  const pending = [];
  const [rt, pa] = await Promise.all([repoTokens(), privateAccess()]);
  if (await control.isManaged()) {
    const st = await control.getState();
    const cfg = (st && st.cfg) || {};
    const g = await ghConfig();
    const team = (Array.isArray(cfg.library) ? cfg.library : cfg.library ? [cfg.library] : []).map((e) => (typeof e === 'string' ? e : e.url));
    if (!team.length && g) team.push(g.defaultLibrary);
    for (const u of team) { const r = repoOf(u); if (r) kinds['repo:' + r] = 'team'; }
    for (const p of (Array.isArray(cfg.privateLibrary) ? cfg.privateLibrary : cfg.privateLibrary ? [cfg.privateLibrary] : []).filter((x) => x && x.repo)) {
      const root = 'https://api.github.com/repos/' + p.repo + '/contents/';
      if (rt[root] || (pa && pa.tokens && pa.tokens[root])) kinds['repo:' + p.repo] = 'private';
      else pending.push(p.repo);
    }
  }
  for (const root of Object.keys(rt)) { const r = repoOf(root); if (r) kinds['repo:' + r] = 'private'; }
  return { kinds, pending };
}
/** icon + tag for a group, using repoStatus().kinds */
export function decorate(g, kinds) {
  if (g.kind !== 'repo') return g;
  const k = kinds[g.key];
  return { ...g, icon: k === 'private' ? 'lock' : 'github', tag: k === 'team' ? 'GitHub · team' : k === 'private' ? 'GitHub · private' : 'GitHub' };
}
