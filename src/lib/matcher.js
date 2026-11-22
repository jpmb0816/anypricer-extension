/**
 * URL pattern matcher.
 *
 * IMPORTANT: `siMatch` must stay fully self-contained (no references to outer
 * scope) because its source is serialised with Function.prototype.toString()
 * and embedded into every injected script so matching runs inside the page.
 *
 * Supported pattern forms (one per line / array item):
 *   *  or  <all_urls>          every http(s)/file/ftp/ws(s) URL
 *   /regex/flags              JavaScript regular expression, tested against the full URL (incl. #hash)
 *   scheme://host/path        Chrome match pattern, e.g. *://*.example.com/app/*
 *   anything with * or ?      glob against the whole URL, e.g. https://*.site.com/*?id=*
 *   plain text                case-insensitive "URL contains" test
 *   # comment                 ignored
 *
 * @param {string} url
 * @param {string[]|string} include
 * @param {string[]|string} exclude
 * @param {boolean} [detail] return a details object instead of a boolean
 */
export function siMatch(url, include, exclude, detail) {
  function esc(s) {
    return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  function glob(g) {
    return esc(g).replace(/\*/g, '.*').replace(/\?/g, '.');
  }
  function compile(raw) {
    const p = String(raw == null ? '' : raw).trim();
    if (!p || p.charAt(0) === '#') return null;
    if (p === '*' || p === '<all_urls>') {
      return { kind: 'all', test: (u) => /^(https?|file|ftp|wss?):/i.test(u) };
    }
    let m = /^\/(.+)\/([dgimsuvy]*)$/.exec(p);
    if (m) {
      const re = new RegExp(m[1], m[2].replace(/[gy]/g, ''));
      return { kind: 'regex', test: (u, full) => re.test(full) };
    }
    m = /^(\*|https?|wss?|file|ftp):\/\/([^/]*)(\/.*)$/.exec(p);
    if (m) {
      const scheme = m[1];
      const host = m[2].toLowerCase();
      const path = m[3];
      const sRe = scheme === '*' ? 'https?' : esc(scheme);
      let hRe;
      if (host === '*') hRe = '[^/]*';
      else if (host.indexOf('*.') === 0) hRe = '(?:[^/]*\\.)?' + esc(host.slice(2)).replace(/\*/g, '[^/]*');
      else if (host.indexOf('*') !== -1) hRe = esc(host).replace(/\*/g, '[^/]*');
      else hRe = esc(host);
      if (host !== '*' && !/:(\d+|\*)$/.test(host)) hRe += '(?::\\d+)?';
      const re = new RegExp('^' + sRe + ':\\/\\/' + hRe + glob(path) + '$');
      return { kind: 'match', test: (u) => re.test(u) };
    }
    if (/[*?]/.test(p)) {
      const re = new RegExp('^' + glob(p) + '$');
      return { kind: 'glob', test: (u) => re.test(u) };
    }
    const low = p.toLowerCase();
    return { kind: 'text', test: (u) => u.toLowerCase().indexOf(low) !== -1 };
  }

  const full = String(url || '');
  const noHash = full.split('#')[0];
  const res = { matched: false, include: null, exclude: null, errors: [] };

  function find(list) {
    const arr = Array.isArray(list) ? list : String(list || '').split('\n');
    let hit = null;
    for (let i = 0; i < arr.length; i++) {
      let c;
      try {
        c = compile(arr[i]);
      } catch (e) {
        res.errors.push(String(arr[i]).trim() + ' → ' + e.message);
        continue;
      }
      if (c && hit === null && c.test(noHash, full)) {
        hit = String(arr[i]).trim();
        if (!detail) return hit;
      }
    }
    return hit;
  }

  res.include = find(include);
  if (res.include || detail) res.exclude = find(exclude);
  res.matched = !!res.include && !res.exclude;
  return detail ? res : res.matched;
}

/** Returns an error message for an invalid pattern, or null if it is valid. */
export function validatePattern(pattern) {
  const r = siMatch('', [pattern], [], true);
  return r.errors.length ? r.errors[0] : null;
}

/** Describes how a pattern will be interpreted (used in the UI). */
export function patternKind(pattern) {
  const p = String(pattern || '').trim();
  if (!p) return 'empty';
  if (p.charAt(0) === '#') return 'comment';
  if (p === '*' || p === '<all_urls>') return 'all URLs';
  if (/^\/(.+)\/([dgimsuvy]*)$/.test(p)) return 'regex';
  if (/^(\*|https?|wss?|file|ftp):\/\/([^/]*)(\/.*)$/.test(p)) return 'match pattern';
  if (/[*?]/.test(p)) return 'glob';
  return 'contains';
}

/**
 * Converts include patterns into native Chrome match patterns when every
 * pattern is a valid match pattern; returns null otherwise (caller should then
 * use <all_urls> and rely on the in-page matcher).
 */
export function toNativeMatches(include) {
  const out = [];
  for (const raw of include || []) {
    const p = String(raw).trim();
    if (!p || p.charAt(0) === '#') continue;
    if (p === '*' || p === '<all_urls>') return ['<all_urls>'];
    if (/^(\*|https?|file|ftp):\/\/(\*|\*\.[^/*:]+|[^/*:]+)?\/.*$/.test(p)) out.push(p);
    else return null;
  }
  return out.length ? out : null;
}
