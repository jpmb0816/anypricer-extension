/**
 * Minimal code editor on top of a <textarea>: line numbers, Tab / Shift+Tab
 * indentation, auto-indent on Enter, Ctrl+/ comment toggle, Ctrl+S save and
 * an error-line marker. Uses execCommand('insertText') so undo/redo keeps working.
 */
export function setupEditor(ta, gutter, { onSave, onChange, getMode } = {}) {
  let errorLine = 0;
  let lastCount = -1;

  function render() {
    const n = ta.value.split('\n').length;
    if (n === lastCount && !render.force) return;
    render.force = false;
    lastCount = n;
    const frag = document.createDocumentFragment();
    for (let i = 1; i <= n; i++) {
      const d = document.createElement('div');
      d.textContent = i;
      if (i === errorLine) d.className = 'err';
      frag.append(d);
    }
    gutter.replaceChildren(frag);
    gutter.scrollTop = ta.scrollTop;
  }

  const insert = (text) => document.execCommand('insertText', false, text);

  function lineBounds(v, s, e) {
    const ls = v.lastIndexOf('\n', s - 1) + 1;
    let le = v.indexOf('\n', e > s && v[e - 1] === '\n' ? e - 1 : e);
    if (le === -1) le = v.length;
    return [ls, le];
  }

  function indent(dedent) {
    const { selectionStart: s, selectionEnd: e, value: v } = ta;
    if (s === e && !dedent) return insert('  ');
    const [ls, le] = lineBounds(v, s, e);
    const block = v.slice(ls, le);
    const out = block
      .split('\n')
      .map((l) => (dedent ? l.replace(/^( {1,2}|\t)/, '') : '  ' + l))
      .join('\n');
    ta.setSelectionRange(ls, le);
    insert(out);
    ta.setSelectionRange(ls, ls + out.length);
  }

  function toggleComment() {
    const css = getMode && getMode() === 'css';
    const { selectionStart: s, selectionEnd: e, value: v } = ta;
    const [ls, le] = lineBounds(v, s, e);
    const lines = v.slice(ls, le).split('\n');
    let out;
    if (css) {
      const block = lines.join('\n');
      const m = /^(\s*)\/\*\s?([\s\S]*?)\s?\*\/\s*$/.exec(block);
      out = m ? m[1] + m[2] : '/* ' + block + ' */';
    } else {
      const all = lines.filter((l) => l.trim()).every((l) => /^\s*\/\//.test(l));
      out = lines.map((l) => (all ? l.replace(/^(\s*)\/\/ ?/, '$1') : l.trim() ? l.replace(/^(\s*)/, '$1// ') : l)).join('\n');
    }
    ta.setSelectionRange(ls, le);
    insert(out);
    ta.setSelectionRange(ls, ls + out.length);
  }

  ta.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Tab' && !mod && !e.altKey) {
      e.preventDefault();
      indent(e.shiftKey);
    } else if (e.key === 'Enter' && !mod && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      const { selectionStart: s, value: v } = ta;
      const ls = v.lastIndexOf('\n', s - 1) + 1;
      const cur = /^[ \t]*/.exec(v.slice(ls, s))[0];
      const prev = v.slice(0, s).trimEnd().slice(-1);
      const next = v.slice(ta.selectionEnd).trimStart().charAt(0);
      if ('{[('.includes(prev) && prev && '}])'.includes(next) && next && v.slice(ta.selectionEnd).match(/^[ \t]*[}\])]/)) {
        insert('\n' + cur + '  ' + '\n' + cur);
        ta.setSelectionRange(s + cur.length + 3, s + cur.length + 3);
      } else {
        insert('\n' + cur + ('{[('.includes(prev) && prev ? '  ' : ''));
      }
    } else if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      onSave && onSave(e.shiftKey);
    } else if (mod && e.key === '/') {
      e.preventDefault();
      toggleComment();
    }
  });
  ta.addEventListener('input', () => {
    render();
    onChange && onChange();
  });
  ta.addEventListener('scroll', () => (gutter.scrollTop = ta.scrollTop));

  return {
    refresh() {
      render.force = true;
      render();
    },
    setError(line) {
      if (errorLine === (line || 0)) return;
      errorLine = line || 0;
      render.force = true;
      render();
    },
    goTo(line) {
      const lines = ta.value.split('\n');
      let pos = 0;
      for (let i = 0; i < Math.min(line - 1, lines.length); i++) pos += lines[i].length + 1;
      ta.focus();
      ta.setSelectionRange(pos, pos + (lines[line - 1] || '').length);
      const lh = parseFloat(getComputedStyle(ta).lineHeight) || 18;
      ta.scrollTop = Math.max(0, (line - 5) * lh);
    }
  };
}
