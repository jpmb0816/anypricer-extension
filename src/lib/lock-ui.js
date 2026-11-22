// Admin lock + remote status for the dashboard and popup (only when this copy is managed through team-config.json "github").
// Locked: every editing control matching `lockSel` is disabled (kept disabled as the page re-renders); viewing still works.
import * as control from './control.js';
import { h } from './dom.js';
import { icon } from './icons.js';

export async function setupLock({ host, lockSel, toggleSel = '', importSel = '', exempt = '[data-lockfree]' }) {
  if (!(await control.isManaged())) return;
  const [info, block, st] = await Promise.all([control.lockInfo(), control.blocked(), control.getState()]);
  const sig = JSON.stringify([!!(info && info.locked), !!(info && info.privateOn), block && block.reason]);
  const locked = !!(info && info.locked);
  // toggles / importing stay usable while locked unless the admin turned them off (code stays hidden either way)
  const sel = [lockSel, info && !info.allowToggles ? toggleSel : '', info && !info.allowImport ? importSel : ''].filter(Boolean).join(',');

  const bar = h('div', { class: 'si-ctl ' + (block ? 'block' : locked ? 'locked' : 'open') });
  if (block) bar.append(h('span', { class: 'grow ctl-msg' }, icon('ban'), block.reason));
  else if (info && !info.noLock) bar.append(h('span', { class: 'grow ctl-msg' }, icon(locked ? 'lock' : 'unlock'), locked ? 'Managed by your admin: editing is locked' : `Unlocked until ${new Date(info.unlockedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`));
  else bar.append(h('span', { class: 'grow ctl-msg' }, icon('shield'), 'Managed by your admin'));
  if (info && info.privateOn) bar.append(h('span', { class: 'pill accent', title: 'Scripts come from the private library on this computer' }, icon('lock'), 'Private library'));
  if (st && st.error && !block) bar.append(h('span', { class: 'muted', title: st.error }, ' (last check failed)'));
  if (info && locked) bar.append(h('button', { type: 'button', class: 'small', 'data-lockfree': true, title: 'The admin key lets you view code and edit', onclick: () => askPassword(bar) }, 'Unlock'));
  else if (info && !info.noLock) bar.append(h('button', { type: 'button', class: 'small', 'data-lockfree': true, onclick: async () => { await control.relock(); location.reload(); } }, 'Lock now'));
  if (info && info.privateOn) bar.append(h('button', { type: 'button', class: 'small', 'data-lockfree': true, title: 'Go back to the public library on this computer (private scripts are removed)', onclick: async () => { if (confirm('Leave the private library on this computer? Private scripts are removed and the public ones are used.')) { await control.leavePrivate(); location.reload(); } } }, 'Leave private'));
  host.prepend(bar);

  if (locked) {
    const apply = () => {
      for (const el of document.querySelectorAll(sel)) {
        if (el.closest('.si-ctl') || el.matches(exempt) || el.disabled) continue;
        el.disabled = true;
        el.dataset.siLocked = '1';
        el.title = 'Locked by your admin';
      }
    };
    apply();
    let q = false;
    new MutationObserver(() => { if (!q) { q = true; requestAnimationFrame(() => { q = false; apply(); }); } }).observe(document.body, { subtree: true, childList: true });
  }
  if (info && !locked && !info.noLock) setTimeout(() => location.reload(), Math.max(1000, info.unlockedUntil - Date.now() + 500));
  // admin changed something online → redraw when the outcome changes
  chrome.storage.onChanged.addListener(async (c, area) => {
    if (area !== 'local' || !(c.control || c.privateAccess)) return;
    const [i2, b2] = await Promise.all([control.lockInfo(), control.blocked()]);
    if (JSON.stringify([!!(i2 && i2.locked), !!(i2 && i2.privateOn), b2 && b2.reason]) !== sig) location.reload();
  });
}

function askPassword(bar) {
  if (bar.querySelector('form')) return;
  const input = h('input', { type: 'password', placeholder: 'Admin key', autocomplete: 'off', 'data-lockfree': true });
  const msg = h('span', { class: 'err-text' });
  const form = h('form', { class: 'si-ctl-form', onsubmit: async (e) => {
    e.preventDefault();
    const wait = await control.unlockWait();
    if (wait) { msg.textContent = `Too many wrong keys: try again in ${Math.ceil(wait / 60000)} min`; return; }
    msg.textContent = 'Checking…';
    if (await control.unlock(input.value)) location.reload();
    else { const w = await control.unlockWait(); msg.textContent = w ? `Wrong key. Locked for ${Math.ceil(w / 60000)} min` : 'Wrong key'; input.select(); }
  } }, input, h('button', { type: 'submit', class: 'small primary', 'data-lockfree': true }, 'OK'), msg);
  bar.append(form);
  input.focus();
}
