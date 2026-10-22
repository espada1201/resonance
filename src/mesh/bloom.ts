// Bloom filter over u32 message ids: the HELLO summary of what a node holds. It is salted with
// the HELLO's own random msgId, which costs no bytes and means a false positive that hides a
// packet from one HELLO is unlikely to hide it again from the next.

/** Most ids a filter is sized for: 9.6 bits each (~1% false positives) caps it at 58 bytes. */
export const MAX_BLOOM_IDS = 48;
const BITS_PER_ID = 9.6;
const MAX_BYTES = Math.ceil((MAX_BLOOM_IDS * BITS_PER_ID) / 8);

/** murmur3's 32-bit finaliser. */
function fmix32(h: number) {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Which of `parts` slices an id falls in. HELLOs summarise one slice at a time, so a summary always fits. */
export const sliceOf = (id: number, parts: number) => fmix32(id ^ 0x5bd1e995) % Math.max(1, parts);

export class Bloom {
  constructor(
    readonly hashes: number,
    readonly bits: Uint8Array,
    readonly salt: number,
  ) {}

  /** No ids give a zero-length filter, which reads as "has nothing". */
  static of(ids: number[], salt: number) {
    const n = ids.length;
    const bytes = Math.min(MAX_BYTES, Math.ceil((n * BITS_PER_ID) / 8));
    const k = n && Math.min(8, Math.max(1, Math.round(((bytes * 8) / n) * Math.LN2)));
    const f = new Bloom(k, new Uint8Array(bytes), salt);
    for (const id of ids) for (const i of f.probes(id)) f.bits[i >> 3] |= 1 << (i & 7);
    return f;
  }

  has(id: number) {
    const probes = this.probes(id);
    return probes.length > 0 && probes.every((i) => this.bits[i >> 3] & (1 << (i & 7)));
  }

  // Double hashing. The size is a whole number of bytes and the step is odd, so 8 probes never repeat a bit.
  private probes(id: number) {
    const m = this.bits.length * 8;
    if (!m) return [];
    const h = fmix32(id ^ this.salt);
    const a = h % m;
    const b = (fmix32(h ^ 0x9e3779b9) % m) | 1;
    return Array.from({ length: this.hashes }, (_, i) => (a + i * b) % m);
  }
}
