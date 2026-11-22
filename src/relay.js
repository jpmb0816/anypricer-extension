// Isolated-world relay: forwards status / error / console / storage events posted by
// injected scripts (in any world) to the service worker, and storage replies back to the page.
// The background validates the per-install token, so spoofed messages are ignored.
(() => {
  if (window.__scriptInjectorRelay) return;
  window.__scriptInjectorRelay = true;

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || typeof d !== 'object' || typeof d.__scriptInjector !== 'string') return;
    try {
      const p = chrome.runtime.sendMessage({ type: 'page-event', payload: d });
      if (d.type === 'kv') {
        // Storage request: send the answer back to the script
        p.then(
          (res) => window.postMessage({ __scriptInjectorReply: d.__scriptInjector, reqId: d.reqId, ok: !!(res && res.ok), result: res && res.result, error: res && res.error }, '*'),
          (err) => window.postMessage({ __scriptInjectorReply: d.__scriptInjector, reqId: d.reqId, ok: false, error: String(err && err.message || err) }, '*')
        );
      } else {
        p.catch(() => {});
      }
    } catch (_) {
      // Extension was reloaded or updated: this context is gone.
    }
  });

  // Data edited in the dashboard → tell the running script
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'kv-changed' && msg.token) {
        window.postMessage({ __scriptInjectorReply: msg.token, type: 'kv-changed', scriptId: msg.scriptId, key: msg.key }, '*');
      }
    });
  } catch (_) { /* context gone */ }
})();
