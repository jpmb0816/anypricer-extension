// Signature checks for managed copies. The admin signs control.json and every library index.json with a private
// ECDSA P-256 key that never leaves their computer (tools/sign.mjs); the matching public key is in team-config.json
// ("github": { "publicKey": "…" }). Script files must match the sha256 listed in a signed index.
// So a stolen GitHub token or a hacked repo cannot push code to users without the signing key.

const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const keyCache = new Map();

async function importKey(spkiB64) {
  if (!keyCache.has(spkiB64)) keyCache.set(spkiB64, crypto.subtle.importKey('spki', b64(spkiB64), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']));
  return keyCache.get(spkiB64);
}

/** Same text the signer signed: the JSON without "signature", compact, in file order; line endings ignored */
export const signedText = (obj) => { const { signature, ...rest } = obj; return JSON.stringify(rest); };

/** Throws unless obj.signature is a valid signature by the admin key */
export async function verifySigned(obj, publicKey) {
  if (!obj || typeof obj.signature !== 'string') throw new Error('Not signed');
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, await importKey(publicKey), b64(obj.signature), new TextEncoder().encode(signedText(obj)));
  if (!ok) throw new Error('Bad signature');
  return obj;
}

/** sha256 hex of text with \r\n normalised (Git may change line endings) */
export async function sha256Text(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text).replace(/\r\n/g, '\n')));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
