// Sandboxed page (no extension APIs, own origin) used to syntax-check user
// code. The code is wrapped in a function / dead branch so it is parsed but
// never executed.
window.addEventListener('message', (e) => {
  if (e.data && e.data.ping) {
    e.source.postMessage({ sandboxReady: true }, '*');
    return;
  }
  const { id, code, mode } = e.data || {};
  if (!id || typeof code !== 'string') return;
  let err = null;
  const onErr = (ev) => {
    const message = String(ev.message || 'SyntaxError')
      .replace(/^Uncaught\s+/, '')
      .replace(/Failed to execute 'appendChild' on 'Node':\s*/, '');
    err = { message, line: ev.lineno, col: ev.colno };
    ev.preventDefault();
  };
  window.addEventListener('error', onErr);
  const s = document.createElement('script');
  s.textContent = (mode === 'wrap' ? 'void async function(console, injector){\n' : 'if(false){\n') + code + '\n}';
  document.head.appendChild(s);
  s.remove();
  window.removeEventListener('error', onErr);
  e.source.postMessage(
    { id, ok: !err, error: err && { message: err.message, line: Math.max(1, (err.line || 2) - 1), col: err.col } },
    '*'
  );
});
window.parent.postMessage({ sandboxReady: true }, '*');
