import { crc32, crc8 } from './crc';
import { rsDecode, rsEncode } from './rs';

// Frame = header codeword (len, version, crc8 + 6 parity) followed by interleaved RS blocks of
// (payload || crc32). On MFSK one byte rides on one symbol, so a lost symbol is a lost byte; on
// OFDM a byte rides on four adjacent carriers, so a notch in the room's response costs few bytes.

export const MAX_PAYLOAD = 255;
export const HEADER_NSYM = 6;
export const HEADER_BYTES = 3 + HEADER_NSYM;
const VERSION = 1;
const MAX_BLOCK_DATA = 40;

export interface Block {
  k: number;
  nsym: number;
}

export function encodeHeader(len: number): Uint8Array {
  const h = [len, VERSION];
  return rsEncode(Uint8Array.from([...h, crc8(h)]), HEADER_NSYM);
}

export function decodeHeader(symbols: Uint8Array, confidence: Float64Array): number | null {
  const res = decodeWithErasures(symbols, HEADER_NSYM, confidence);
  if (!res) return null;
  const [len, ver, c] = res.data;
  if (ver !== VERSION || crc8([len, ver]) !== c || len === 0) return null;
  return len;
}

export function planBlocks(payloadLen: number): Block[] {
  const total = payloadLen + 4;
  const n = Math.ceil(total / MAX_BLOCK_DATA);
  const blocks: Block[] = [];
  for (let i = 0; i < n; i++) {
    const k = Math.floor(total / n) + (i < total % n ? 1 : 0);
    blocks.push({ k, nsym: Math.max(8, Math.ceil(k / 2)) });
  }
  return blocks;
}

export const bodyBytes = (payloadLen: number) =>
  planBlocks(payloadLen).reduce((s, b) => s + b.k + b.nsym, 0);

/** Order in which codeword bytes go on air: round-robin across blocks so bursts spread out. */
function interleaveOrder(blocks: Block[]): Array<[number, number]> {
  const order: Array<[number, number]> = [];
  const maxN = Math.max(...blocks.map((b) => b.k + b.nsym));
  for (let j = 0; j < maxN; j++) blocks.forEach((b, i) => j < b.k + b.nsym && order.push([i, j]));
  return order;
}

export function encodeBody(payload: Uint8Array): Uint8Array {
  if (payload.length < 1 || payload.length > MAX_PAYLOAD) throw new Error('payload must be 1..255 bytes');
  const data = new Uint8Array(payload.length + 4);
  data.set(payload);
  new DataView(data.buffer).setUint32(payload.length, crc32(payload));
  const blocks = planBlocks(payload.length);
  let off = 0;
  const cws = blocks.map((b) => {
    const cw = rsEncode(data.subarray(off, off + b.k), b.nsym);
    off += b.k;
    return cw;
  });
  return Uint8Array.from(interleaveOrder(blocks).map(([i, j]) => cws[i][j]));
}

export interface BodyResult {
  payload: Uint8Array;
  corrected: number;
}

export function decodeBody(payloadLen: number, symbols: Uint8Array, confidence: Float64Array): BodyResult | null {
  const blocks = planBlocks(payloadLen);
  const cws = blocks.map((b) => ({ bytes: new Uint8Array(b.k + b.nsym), conf: new Float64Array(b.k + b.nsym) }));
  interleaveOrder(blocks).forEach(([i, j], idx) => {
    cws[i].bytes[j] = symbols[idx];
    cws[i].conf[j] = confidence[idx];
  });
  const data = new Uint8Array(payloadLen + 4);
  let off = 0;
  let corrected = 0;
  for (let i = 0; i < blocks.length; i++) {
    const res = decodeWithErasures(cws[i].bytes, blocks[i].nsym, cws[i].conf);
    if (!res) return null;
    data.set(res.data, off);
    off += res.data.length;
    corrected += res.corrected;
  }
  const payload = data.slice(0, payloadLen);
  if (new DataView(data.buffer).getUint32(payloadLen) !== crc32(payload)) return null;
  return { payload, corrected };
}

/** Errors-only first, then progressively erase the least confident symbols. */
function decodeWithErasures(cw: Uint8Array, nsym: number, conf: Float64Array) {
  const byConf = [...cw.keys()].sort((a, b) => conf[a] - conf[b]);
  // Never erase the full parity budget: keep two symbols of redundancy as a miscorrection check.
  const tries = new Set([0, nsym >> 2, nsym >> 1, (3 * nsym) >> 2, nsym - 2]);
  for (const e of tries) {
    const res = rsDecode(cw, nsym, byConf.slice(0, e));
    if (res) return res;
  }
  return null;
}
