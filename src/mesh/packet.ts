// Mesh packet wire format (13-byte header, then the type-specific body):
//   0      ver:2 | type:4 | encrypted:1 | ackRequested:1
//   1..4   message id (random u32)
//   5..7   source node id (u24)
//   8..10  destination node id (u24, 0xFFFFFF = everyone)
//   11     ttl:3 | hops:3 | attempt:2     <- the only byte relays rewrite
//   12     channel (0 = open channel, otherwise derived from the circle passphrase)

const VERSION = 1;
export const HEADER_LEN = 13;
export const BROADCAST = 0xffffff;

export enum PacketType {
  Text = 1,
  CheckIn = 2,
  Contact = 3,
  FileChunk = 4,
  Ack = 5,
  Hello = 6,
  FileRequest = 7,
  Range = 8,
}

export interface Packet {
  type: PacketType;
  encrypted: boolean;
  ackRequested: boolean;
  msgId: number;
  src: number;
  dst: number;
  ttl: number;
  hops: number;
  attempt: number;
  channel: number;
  body: Uint8Array;
}

export function encodePacket(p: Packet): Uint8Array {
  const out = new Uint8Array(HEADER_LEN + p.body.length);
  const v = new DataView(out.buffer);
  out[0] = (VERSION << 6) | ((p.type & 15) << 2) | (p.encrypted ? 2 : 0) | (p.ackRequested ? 1 : 0);
  v.setUint32(1, p.msgId >>> 0);
  writeU24(out, 5, p.src);
  writeU24(out, 8, p.dst);
  out[11] = ((p.ttl & 7) << 5) | ((p.hops & 7) << 2) | (p.attempt & 3);
  out[12] = p.channel & 0xff;
  out.set(p.body, HEADER_LEN);
  return out;
}

export function decodePacket(bytes: Uint8Array): Packet | null {
  if (bytes.length < HEADER_LEN || bytes[0] >> 6 !== VERSION) return null;
  const type = (bytes[0] >> 2) & 15;
  if (!(type in PacketType)) return null;
  const ttl = bytes[11] >> 5;
  const hops = (bytes[11] >> 2) & 7;
  if (ttl === 0 || hops >= ttl) return null;
  return {
    type,
    encrypted: !!(bytes[0] & 2),
    ackRequested: !!(bytes[0] & 1),
    msgId: new DataView(bytes.buffer, bytes.byteOffset).getUint32(1),
    src: readU24(bytes, 5),
    dst: readU24(bytes, 8),
    ttl,
    hops,
    attempt: bytes[11] & 3,
    channel: bytes[12],
    body: bytes.slice(HEADER_LEN),
  };
}

/** Header bytes that relays never change; authenticated as AES-GCM additional data. */
export const immutableHeader = (p: Packet) =>
  encodePacket({ ...p, ttl: 0, hops: 0, attempt: 0, body: new Uint8Array(0) });

export const randomU32 = () => crypto.getRandomValues(new Uint32Array(1))[0];
export const randomNodeId = () => (randomU32() & 0xfffffe) | 1; // never 0 or BROADCAST
export const nodeLabel = (id: number) => id.toString(16).padStart(6, '0').toUpperCase();

function writeU24(b: Uint8Array, o: number, v: number) {
  b[o] = (v >> 16) & 255;
  b[o + 1] = (v >> 8) & 255;
  b[o + 2] = v & 255;
}
function readU24(b: Uint8Array, o: number) {
  return (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
}
