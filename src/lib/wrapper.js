import { siMatch } from './matcher.js';

/**
 * Runtime that is serialised into every injected script. Must be self-contained.
 * Returns null when the script should not run on this page (URL guard), or an
 * API object used by the generated wrapper.
 */
function siRuntime(SI, match) {
  if (!SI.force) {
    try {
      if (SI.disabledHosts.indexOf(location.hostname) !== -1) return null;
      if (!match(location.href, SI.include, SI.exclude)) return null;
    } catch (_) {
      return null;
    }
  }

  const post = (type, data) => {
    try {
      let isFrame = false;
      try { isFrame = window.top !== window; } catch (_) { isFrame = true; }
      window.postMessage(Object.assign({
        __scriptInjector: SI.token,
        type,
        scriptId: SI.id,
        scriptName: SI.name,
        url: location.href,
        isFrame,
        trigger: SI.trigger,
        time: Date.now()
      }, data || {}), '*');
    } catch (_) { /* ignore */ }
  };

  const tag = '__' + SI.id + '.js';
  const tagRe = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fixStack = (stack) => String(stack || '').replace(
    new RegExp(tagRe + ':(\\d+)(?::(\\d+))?', 'g'),
    (m, l, c) => tag + ':' + Math.max(1, l - SI.offset) + (c ? ':' + c : '')
  );
  const locate = (stack) => {
    const m = new RegExp(tagRe + ':(\\d+):(\\d+)').exec(String(stack || ''));
    return m ? { line: Math.max(1, m[1] - SI.offset), col: +m[2] } : {};
  };

  const report = (err, extra) => {
    extra = extra || {};
    const info = {
      kind: extra.kind || 'exception',
      name: (err && err.name) || 'Error',
      message: (err && err.message != null ? String(err.message) : (extra.message || String(err))),
      stack: err && err.stack ? fixStack(err.stack) : ''
    };
    Object.assign(info, locate(err && err.stack));
    if (!info.line && extra.line) {
      info.line = Math.max(1, extra.line - SI.offset);
      info.col = extra.col;
    }
    post('error', info);
    if (typeof noteError === 'function') noteError(info.message);
  };

  // One global listener pair per world/frame, shared by all injected scripts.
  const KEY = Symbol.for('scriptInjector.registry');
  let reg = window[KEY];
  if (!reg) {
    reg = { scripts: {} };
    try { Object.defineProperty(window, KEY, { value: reg }); } catch (_) { /* ignore */ }
    const idOf = (s) => {
      const m = /__([A-Za-z0-9-]+)\.js/.exec(String(s || ''));
      return m && reg.scripts[m[1]] ? m[1] : null;
    };
    window.addEventListener('error', (ev) => {
      const id = idOf(ev.filename) || idOf(ev.error && ev.error.stack);
      if (id) reg.scripts[id](ev.error || { message: ev.message }, { kind: 'uncaught', message: ev.message, line: ev.lineno, col: ev.colno });
    });
    window.addEventListener('unhandledrejection', (ev) => {
      const id = idOf(ev.reason && ev.reason.stack);
      if (id) reg.scripts[id](ev.reason, { kind: 'unhandledrejection' });
    });
  }
  reg.scripts[SI.id] = report;

  const fmt = (v) => {
    if (typeof v === 'string') return v;
    if (v instanceof Error) return v.stack || String(v);
    try {
      const s = JSON.stringify(v);
      return s === undefined ? String(v) : s;
    } catch (_) {
      return String(v);
    }
  };
  const makeConsole = () => {
    const real = window.console;
    if (!SI.captureConsole) return real;
    const levels = { log: 1, info: 1, warn: 1, error: 1, debug: 1 };
    return new Proxy(real, {
      get(t, k) {
        const v = t[k];
        if (typeof v !== 'function') return v;
        if (!levels[k]) return v.bind(t);
        return (...args) => {
          v.apply(t, args);
          post('console', { level: k, message: args.map(fmt).join(' ').slice(0, 4000) });
        };
      }
    });
  };

  // Per-script persistent storage kept by the extension (visible in the dashboard's Data view).
  // Requests go page → relay content script → service worker; replies come back via postMessage.
  const pending = {};
  let seq = 0;
  const kv = (op, key, value) => new Promise((resolve, reject) => {
    const reqId = SI.id + '-' + (++seq) + '-' + Math.random().toString(36).slice(2, 8);
    pending[reqId] = { resolve, reject };
    post('kv', { op, key, value, reqId });
    setTimeout(() => {
      if (pending[reqId]) { delete pending[reqId]; reject(new Error('Script storage timed out')); }
    }, 15000);
  });
  const changeHandlers = [];
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.__scriptInjectorReply !== SI.token) return;
    if (d.type === 'kv-changed') {
      if (d.scriptId === SI.id) changeHandlers.forEach((fn) => { try { fn(d.key); } catch (_) { /* ignore */ } });
      return;
    }
    const p = pending[d.reqId];
    if (!p) return;
    delete pending[d.reqId];
    if (d.ok) p.resolve(d.result); else p.reject(new Error(d.error || 'Script storage error'));
  });
  const storage = Object.freeze({
    get: (key) => kv('get', String(key)),
    set: (key, value) => kv('set', String(key), value),
    remove: (key) => kv('remove', String(key)),
    list: () => kv('list'),
    syncStatus: () => kv('sync'),
    syncNow: () => kv('syncnow'), // upload waiting changes now → { state, error, pending } // { state: ok|off|paused|error, lastSync, lastPush, error, pendingMine }
    getAll: () => kv('getAll'),
    // Called when the data is edited from the dashboard (not for this script's own writes)
    onChange: (fn) => { if (typeof fn === 'function') changeHandlers.push(fn); }
  });

  // ---------- Loading status: injector.loading(msg) / injector.ready(msg) + on-page status pill ----------
  // Shared by every script on the page (the top frame draws the pill). A script that never calls these
  // counts as ready once its code has run.
  const SKEY = Symbol.for('scriptInjector.status');
  let sreg = window[SKEY];
  if (!sreg) {
    sreg = { items: {}, render: null };
    try { Object.defineProperty(window, SKEY, { value: sreg }); } catch (_) { /* ignore */ }
  }
  let explicit = false;
  const setStatus = (state, msg, auto) => {
    if (!auto) explicit = true;
    const prev = sreg.items[SI.id];
    msg = msg == null ? '' : String(msg).slice(0, 200);
    if (prev && prev.state === state && prev.msg === msg) return;
    sreg.items[SI.id] = { name: SI.name, state, msg, since: prev && prev.state === state ? prev.since : Date.now(), errors: prev ? prev.errors : 0 };
    post('status', { state, message: msg });
    if (sreg.render) sreg.render();
  };
  const noteError = (message) => {
    const it = sreg.items[SI.id] || (sreg.items[SI.id] = { name: SI.name, state: 'ready', msg: '', since: Date.now(), errors: 0 });
    it.errors++;
    it.lastError = message ? String(message).slice(0, 300) : '';
    if (sreg.render) sreg.render();
  };

  let isTop = true;
  try { isTop = window.top === window; } catch (_) { isTop = false; }
  if (SI.statusStyle !== 'off' && isTop && !sreg.render) {
    let host = null;
    let open = false;
    let hideTimer = null;
    let lastSig = '';
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const secs = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's'; };
    const css = `:host{all:initial}
.p{position:fixed;right:12px;bottom:12px;z-index:2147483646;font:12px/1.35 system-ui,-apple-system,"Segoe UI",Arial,sans-serif;color:#e6e8ea;transition:opacity .4s}
.p.fade{opacity:0;pointer-events:none}
.b{display:flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:13px;background:#1f2327;border:1px solid #3b4148;box-shadow:0 2px 10px rgba(0,0,0,.35);cursor:pointer;user-select:none;white-space:nowrap}
.b:hover{border-color:#5a626b}
.l{position:absolute;right:0;bottom:32px;min-width:260px;max-width:380px;background:#1f2327;border:1px solid #3b4148;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.45);padding:4px 0}
.h{display:flex;justify-content:space-between;padding:4px 10px 6px;color:#9ba4ad;font-size:11px;border-bottom:1px solid #2e3338}
.h button{all:unset;cursor:pointer;color:#9ba4ad}.h button:hover{color:#e6e8ea}
.r{display:flex;gap:7px;align-items:flex-start;padding:5px 10px}
.n{font-weight:600}.m{color:#9ba4ad;font-size:11px}
.ic{flex:none;width:12px;height:12px;margin-top:2px}
.b .ic{margin-top:0}
.ok{color:#5fd38d}.ld{color:#62bbff}.er{color:#ff6b6b}
.spin{animation:s 1s linear infinite}@keyframes s{to{transform:rotate(360deg)}}`;
    const ICON = {
      loading: '<svg class="ic ld spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.2-8.6"/></svg>',
      ready: '<svg class="ic ok" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
      error: '<svg class="ic er" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>'
    };
    const drawPill = () => {
      const items = Object.values(sreg.items);
      if (!items.length) return;
      if (!host || !host.isConnected) {
        host = document.createElement('div');
        host.id = 'script-injector-status';
        const root = host.attachShadow({ mode: 'open' });
        root.innerHTML = `<style>${css}</style><div class="p"></div>`;
        root.addEventListener('click', (e) => {
          if (e.target.closest('[data-x]')) { open = false; for (const i of Object.values(sreg.items)) i.errors = 0; lastSig = ''; drawPill(); return; }
          if (e.target.closest('.b')) { open = !open; lastSig = ''; drawPill(); }
        });
        (document.body || document.documentElement).appendChild(host);
        lastSig = '';
      }
      const loading = items.filter((i) => i.state === 'loading');
      const errs = items.reduce((a, i) => a + (i.errors || 0), 0);
      const busy = loading.length > 0;
      const sig = JSON.stringify([open, items.map((i) => [i.name, i.state, i.msg, i.errors, i.state === 'loading' ? secs(i.since) : ''])]);
      if (sig === lastSig) return;
      lastSig = sig;
      const p = host.shadowRoot.querySelector('.p');
      const label = busy
        ? `${ICON.loading}<span>${loading.length === 1 ? esc(loading[0].msg || 'Loading ' + loading[0].name) : loading.length + ' loading'}</span><span class="m">${items.length - loading.length}/${items.length} ready</span>`
        : `${ICON.ready}<span>All ready</span><span class="m">${items.length} script${items.length === 1 ? '' : 's'}</span>`;
      const row = (i) => `<div class="r">${i.errors ? ICON.error : ICON[i.state] || ICON.ready}<div><div class="n">${esc(i.name)}</div><div class="m">${i.state === 'loading' ? esc(i.msg || 'Loading') + ' · ' + secs(i.since) : esc(i.msg || (i.state === 'error' ? 'Failed' : 'Ready'))}${i.errors ? ` · <span class="er">${i.errors} error${i.errors > 1 ? 's' : ''} (see extension logs)</span>` : ''}</div></div></div>`;
      const list = open ? `<div class="l"><div class="h"><span>Script Injector</span><button data-x title="Close and clear the error marks">close</button></div>${items.map(row).join('')}</div>` : '';
      p.innerHTML = `${list}<div class="b" title="Script status: click for details">${label}${errs ? `<span class="er">${ICON.error} ${errs}</span>` : ''}</div>`;
      clearTimeout(hideTimer);
      p.classList.remove('fade');
      if (!busy && !errs && !open) hideTimer = setTimeout(() => p.classList.add('fade'), 3000);
    };
    // Site toasts: when the page has toastr (e.g. AnyPricer), show ONE status toast in the site's own style.
    // Only our own toasts are touched (never toastr.options / toastr.clear() without a target).
    const useToastr = () => SI.statusStyle === 'auto' && window.toastr && typeof window.toastr.info === 'function' && typeof window.toastr.clear === 'function';
    const TOAST_DELAY = 700; // quick loads don't flash a toast
    const T = { el: null, at: 0, busyStart: 0, shown: false, errSeen: {}, timer: null };
    const toastOpts = (extra) => Object.assign({ escapeHtml: true, closeButton: false, progressBar: false, newestOnTop: true, preventDuplicates: false }, extra);
    const drawToast = () => {
      if (host && host.isConnected) host.remove(); // pill not used in this mode
      const tr = window.toastr;
      const items = Object.values(sreg.items);
      const loading = items.filter((i) => i.state === 'loading');
      // Errors: one red toast per new error
      for (const i of items) {
        const key = i.name;
        const n = i.errors || 0;
        if (n > (T.errSeen[key] || 0)) {
          tr.error(i.lastError || (i.state === 'error' && i.msg) || 'An error occurred: see Script Injector logs', i.name, toastOpts({ timeOut: 8000, extendedTimeOut: 3000, closeButton: true }));
        }
        T.errSeen[key] = n;
      }
      if (loading.length) {
        if (!T.busyStart) T.busyStart = Date.now();
        const wait = TOAST_DELAY - (Date.now() - T.busyStart);
        if (wait > 0) { clearTimeout(T.timer); T.timer = setTimeout(drawToast, wait + 20); return; }
        const first = loading[0];
        const msg = (loading.length === 1 ? (first.msg || 'Loading ' + first.name) : loading.length + ' scripts loading') +
          ' (' + secs(first.since) + ') · ' + (items.length - loading.length) + '/' + items.length + ' ready';
        const title = loading.length === 1 ? first.name : 'Script Injector';
        // The site sometimes calls toastr.clear(): show ours again if it was removed
        // (a toast that is fading out after the site's clear counts as gone)
        if (!T.el || !T.el[0] || !document.contains(T.el[0]) || (Date.now() - T.at > 600 && T.el.is && T.el.is(':animated'))) {
          T.at = Date.now(); // fade-in animation right after creation is not a fade-out
          T.el = tr.info(msg, title, toastOpts({ timeOut: 0, extendedTimeOut: 0, tapToDismiss: false }));
          if (T.el && T.el.attr) T.el.attr('data-si-status', '1');
        } else {
          T.el.find('.toast-message').text(msg);
          T.el.find('.toast-title').text(title);
        }
        T.shown = true;
      } else {
        clearTimeout(T.timer);
        T.busyStart = 0;
        if (T.el) { try { tr.clear(T.el, { force: true }); } catch (_) { /* ignore */ } T.el = null; }
        if (T.shown) {
          T.shown = false;
          tr.success(items.length + ' script' + (items.length === 1 ? '' : 's') + ' ready', 'All scripts ready', toastOpts({ timeOut: 2000, extendedTimeOut: 1000 }));
        }
      }
    };
    sreg.render = () => (useToastr() ? drawToast() : drawPill());
    // Keep the "waiting … 12s" counters moving while something loads
    setInterval(() => { if (Object.values(sreg.items).some((i) => i.state === 'loading')) sreg.render(); }, 1000);
  }

  const api = {
    post,
    report,
    start(fn) {
      const go = async () => {
        post('ran', {});
        setStatus('loading', 'Starting', true);
        explicit = false;
        try {
          await fn(makeConsole(), api.context);
          if (!explicit) setStatus('ready', '', true);
        } catch (e) {
          report(e, { kind: 'exception' });
          setStatus('error', String((e && e.message) || e), true);
        }
      };
      if (SI.delay > 0) setTimeout(go, SI.delay); else go();
    },
    context: Object.freeze({
      id: SI.id,
      name: SI.name,
      trigger: SI.trigger,
      report: (e) => report(e, { kind: 'reported' }),
      storage,
      // Show that the script is busy (e.g. 'Waiting for Zone Inventory') / done: shown in the page pill and the popup
      loading: (msg) => setStatus('loading', msg || 'Loading'),
      ready: (msg) => setStatus('ready', msg || ''),
      log: (...a) => post('console', { level: 'info', message: a.map(fmt).join(' ').slice(0, 4000) })
    })
  };
  return api;
}

export function safeName(name) {
  return String(name || 'script').replace(/[^\w.-]+/g, '_').replace(/_+/g, '_').slice(0, 60) || 'script';
}

/**
 * Builds the final code string for a JS script.
 * @param {object} script normalised script
 * @param {{token:string, disabledHosts:string[], force?:boolean, trigger?:string, requireCode?:string}} ctx
 */
export function buildScriptCode(script, ctx) {
  const cfg = {
    id: script.id,
    name: script.name,
    include: script.include || [],
    exclude: script.exclude || [],
    disabledHosts: ctx.disabledHosts || [],
    delay: script.wrap ? Math.max(0, +script.delay || 0) : 0,
    force: !!ctx.force,
    trigger: ctx.trigger || 'auto',
    token: ctx.token,
    captureConsole: !!(script.wrap && script.captureConsole),
    statusStyle: ['auto', 'pill', 'off'].includes(ctx.statusStyle) ? ctx.statusStyle : 'auto',
    offset: '__SI_OFFSET__'
  };
  const runtime = `(${siRuntime.toString()})(${JSON.stringify(cfg)}, ${siMatch.toString()})`;
  const requires = ctx.requireCode ? ctx.requireCode + '\n' : '';
  let prelude;
  let epilogue;
  if (script.wrap) {
    prelude =
      '(() => {\n' +
      `const __si = ${runtime};\n` +
      'if (!__si) return;\n' +
      requires +
      'const __siUser = async (console, injector) => {\n';
    epilogue = '\n};\n__si.start(__siUser);\n})();\n';
  } else {
    prelude =
      'if ((() => {\n' +
      `const __si = ${runtime};\n` +
      'if (!__si) return false;\n' +
      "__si.post('ran', {});\n" +
      'return true;\n' +
      '})()) {\n' +
      requires;
    epilogue = '\n}\n';
  }
  const offset = prelude.split('\n').length - 1;
  prelude = prelude.replace('"__SI_OFFSET__"', String(offset));
  return prelude + script.code + epilogue + `//# sourceURL=script-injector/${safeName(script.name)}__${script.id}.js`;
}

/**
 * Executed via chrome.scripting in the page's MAIN world when the userScripts
 * API is unavailable. Must be self-contained.
 */
export function injectViaTag(code, id) {
  const key = '__si_ok_' + id + '_' + Math.random().toString(36).slice(2);
  try {
    const s = document.createElement('script');
    s.textContent = 'window[' + JSON.stringify(key) + ']=1;' + code;
    (document.head || document.documentElement).appendChild(s);
    s.remove();
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  const ok = window[key] === 1;
  try { delete window[key]; } catch (_) { /* ignore */ }
  return ok
    ? { ok: true }
    : { ok: false, error: "Blocked by the page's Content-Security-Policy. Turn on \"Allow User Scripts\" for this extension to bypass CSP." };
}
