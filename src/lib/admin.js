// Admin computer = the developer copy (loaded from the source folder) or a copy unlocked with the admin key right now.
// Admin-only things (size alert, admin setup, full online check) are offered only there.
import { isDevCopy } from './ext-update.js';
import { lockInfo } from './control.js';

export async function isAdminPc() {
  if (await isDevCopy()) return true;
  const l = await lockInfo().catch(() => null);
  return !!(l && l.unlockedUntil > Date.now());
}
