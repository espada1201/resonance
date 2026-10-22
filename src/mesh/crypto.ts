import { type Packet, immutableHeader } from './packet';

// Optional end-to-end encryption for a "circle": everyone who knows the passphrase.
// PBKDF2-SHA256 stretches the passphrase into an AES-256-GCM key plus a one-byte channel tag.
// The nonce is built from the packet's random message id and sender id, so it costs no airtime,
// and the immutable header is authenticated so relays cannot re-address a sealed message.

const SALT = new TextEncoder().encode('resonance/circle/v2');
// OWASP's 2023 figure for PBKDF2-HMAC-SHA256. Anyone who records one sealed message can test
// guesses offline, so this (and the passphrase) is all that stands between them and the circle.
const ITERATIONS = 600_000;
const TAG_BITS = 96;
export const SEAL_OVERHEAD = TAG_BITS / 8;

export interface Circle {
  channel: number;
  key: CryptoKey;
}

/** One PBKDF2 block, all of it the key: a guesser needs only the key, so a second block would slow only us. */
export async function deriveCircle(passphrase: string): Promise<Circle> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: SALT, iterations: ITERATIONS }, base, 256);
  const key = await crypto.subtle.importKey('raw', bits, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const tag = new Uint8Array(await crypto.subtle.digest('SHA-256', bits));
  return { key, channel: tag[0] || 1 };
}

function nonce(p: Packet): Uint8Array<ArrayBuffer> {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setUint32(0, p.msgId >>> 0);
  iv[4] = (p.src >> 16) & 255;
  iv[5] = (p.src >> 8) & 255;
  iv[6] = p.src & 255;
  iv[7] = p.type;
  return iv;
}

/** Encrypts `plain` for packet `p` (whose header fields must already be final). */
export async function seal(circle: Circle, p: Packet, plain: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const params = { name: 'AES-GCM', iv: nonce(p), additionalData: immutableHeader(p) as Uint8Array<ArrayBuffer>, tagLength: TAG_BITS };
  return new Uint8Array(await crypto.subtle.encrypt(params, circle.key, plain));
}

/** Returns the plaintext body, or null if this circle cannot open it (wrong key or tampered). */
export async function open(circle: Circle, p: Packet): Promise<Uint8Array | null> {
  if (!p.encrypted || p.channel !== circle.channel) return null;
  try {
    const params = { name: 'AES-GCM', iv: nonce(p), additionalData: immutableHeader(p) as Uint8Array<ArrayBuffer>, tagLength: TAG_BITS };
    return new Uint8Array(await crypto.subtle.decrypt(params, circle.key, p.body as Uint8Array<ArrayBuffer>));
  } catch {
    return null;
  }
}
