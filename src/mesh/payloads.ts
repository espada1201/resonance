import { PacketType } from './packet';

// Compact binary bodies. Every byte costs ~32 ms of airtime in the audible mode, so strings are
// length-prefixed UTF-8, coordinates are fixed-point and timestamps are whole seconds.

export type Status = 'safe' | 'help' | 'medical' | 'sheltering';
export const STATUSES: Status[] = ['safe', 'help', 'medical', 'sheltering'];

export interface Geo {
  lat: number;
  lon: number;
  accuracyM: number;
}

export type Body =
  | { kind: 'text'; ts: number; nick: string; text: string }
  | { kind: 'checkin'; ts: number; nick: string; status: Status; geo?: Geo; note: string }
  | { kind: 'contact'; ts: number; name: string; phone: string; note: string }
  | { kind: 'file'; fileId: number; index: number; total: number; meta?: FileMeta; data: Uint8Array }
  | { kind: 'ack'; msgId: number; attempt: number }
  /** `hashes` and `bits` are a Bloom filter of the message ids the sender holds in slice `part` of `parts` (see bloom.ts). */
  | { kind: 'hello'; role: 'phone' | 'beacon'; nick: string; hashes: number; part: number; parts: number; bits: Uint8Array }
  | { kind: 'filereq'; fileSrc: number; fileId: number; missing: number[] }
  | { kind: 'range'; phase: 'request' | 'report'; session: number; intervalUs: number };

export interface FileMeta {
  name: string;
  mime: string;
  size: number;
}

export const typeOf: Record<Body['kind'], PacketType> = {
  text: PacketType.Text,
  checkin: PacketType.CheckIn,
  contact: PacketType.Contact,
  file: PacketType.FileChunk,
  ack: PacketType.Ack,
  hello: PacketType.Hello,
  filereq: PacketType.FileRequest,
  range: PacketType.Range,
};

class Writer {
  private bytes: number[] = [];
  u8(v: number) {
    this.bytes.push(v & 255);
    return this;
  }
  u16(v: number) {
    return this.u8(v >> 8).u8(v);
  }
  u24(v: number) {
    return this.u8(v >> 16).u16(v);
  }
  u32(v: number) {
    return this.u16(v >>> 16).u16(v);
  }
  i32(v: number) {
    return this.u32(v >>> 0);
  }
  str(s: string, max: number) {
    const b = new TextEncoder().encode(fitUtf8(s, max));
    this.u8(b.length);
    return this.raw(b);
  }
  raw(b: Uint8Array) {
    for (const x of b) this.bytes.push(x);
    return this;
  }
  done() {
    return Uint8Array.from(this.bytes);
  }
}

class Reader {
  private o = 0;
  constructor(private readonly b: Uint8Array) {}
  u8() {
    if (this.o >= this.b.length) throw new RangeError('truncated');
    return this.b[this.o++];
  }
  u16() {
    return (this.u8() << 8) | this.u8();
  }
  u24() {
    return (this.u8() << 16) | this.u16();
  }
  u32() {
    return ((this.u16() << 16) | this.u16()) >>> 0;
  }
  i32() {
    return this.u32() | 0;
  }
  str() {
    return new TextDecoder().decode(this.raw(this.u8()));
  }
  raw(n: number) {
    if (this.o + n > this.b.length) throw new RangeError('truncated');
    const out = this.b.slice(this.o, this.o + n);
    this.o += n;
    return out;
  }
  rest() {
    return this.raw(this.b.length - this.o);
  }
}

/** The longest start of `s`, cut at a character boundary, whose UTF-8 fits in `max` bytes. */
export function fitUtf8(s: string, max: number): string {
  const enc = new TextEncoder();
  let chars = [...s];
  while (enc.encode(chars.join('')).length > max) chars = chars.slice(0, -1);
  return chars.join('');
}

/** Name fields are length-prefixed byte strings on air; inputs hold the same limits in bytes. */
export const MAX_NICK = 16;
export const MAX_CONTACT_NAME = 40;
export const MAX_CONTACT_PHONE = 24;
export const nowSec = () => Math.floor(Date.now() / 1000);

export function encodeBody(body: Body): Uint8Array {
  const w = new Writer();
  switch (body.kind) {
    case 'text':
      return w.u32(body.ts).str(body.nick, MAX_NICK).raw(new TextEncoder().encode(body.text)).done();
    case 'checkin': {
      w.u32(body.ts).u8(STATUSES.indexOf(body.status)).u8(body.geo ? 1 : 0);
      if (body.geo) {
        w.i32(Math.round(body.geo.lat * 1e5)).i32(Math.round(body.geo.lon * 1e5));
        w.u16(Math.min(65535, Math.round(body.geo.accuracyM)));
      }
      return w.str(body.nick, MAX_NICK).raw(new TextEncoder().encode(body.note)).done();
    }
    case 'contact':
      return w.u32(body.ts).str(body.name, MAX_CONTACT_NAME).str(body.phone, MAX_CONTACT_PHONE).raw(new TextEncoder().encode(body.note)).done();
    case 'file':
      w.u16(body.fileId).u8(body.index).u8(body.total);
      if (body.index === 0) {
        const m = body.meta ?? { name: 'file', mime: '', size: 0 };
        w.str(m.name, 48).str(m.mime, 40).u16(m.size);
      }
      return w.raw(body.data).done();
    case 'ack':
      return w.u32(body.msgId).u8(body.attempt).done();
    case 'hello':
      return w.u8(body.role === 'beacon' ? 1 : 0).str(body.nick, MAX_NICK).u8(body.hashes).u8(body.part).u8(body.parts).raw(body.bits).done();
    case 'filereq': {
      w.u24(body.fileSrc).u16(body.fileId);
      const mask = new Uint8Array(32);
      for (const i of body.missing) mask[i >> 3] |= 1 << (i & 7);
      let len = 32;
      while (len > 0 && mask[len - 1] === 0) len--;
      return w.u8(len).raw(mask.slice(0, len)).done();
    }
    case 'range':
      return w.u8(body.phase === 'report' ? 1 : 0).u16(body.session).u32(body.intervalUs).done();
  }
}

export function decodeBody(type: PacketType, bytes: Uint8Array): Body | null {
  const r = new Reader(bytes);
  try {
    switch (type) {
      case PacketType.Text:
        return { kind: 'text', ts: r.u32(), nick: r.str(), text: new TextDecoder().decode(r.rest()) };
      case PacketType.CheckIn: {
        const ts = r.u32();
        const status = STATUSES[r.u8()] ?? 'safe';
        const geo = r.u8() ? { lat: r.i32() / 1e5, lon: r.i32() / 1e5, accuracyM: r.u16() } : undefined;
        return { kind: 'checkin', ts, status, geo, nick: r.str(), note: new TextDecoder().decode(r.rest()) };
      }
      case PacketType.Contact:
        return { kind: 'contact', ts: r.u32(), name: r.str(), phone: r.str(), note: new TextDecoder().decode(r.rest()) };
      case PacketType.FileChunk: {
        const fileId = r.u16();
        const index = r.u8();
        const total = r.u8();
        const meta = index === 0 ? { name: r.str(), mime: r.str(), size: r.u16() } : undefined;
        return { kind: 'file', fileId, index, total, meta, data: r.rest() };
      }
      case PacketType.Ack:
        return { kind: 'ack', msgId: r.u32(), attempt: r.u8() };
      case PacketType.Hello: {
        const role = r.u8() ? 'beacon' : 'phone';
        const nick = r.str();
        return { kind: 'hello', role, nick, hashes: r.u8(), part: r.u8(), parts: r.u8(), bits: r.rest() };
      }
      case PacketType.FileRequest: {
        const fileSrc = r.u24();
        const fileId = r.u16();
        const mask = r.raw(r.u8());
        const missing: number[] = [];
        mask.forEach((b, i) => {
          for (let k = 0; k < 8; k++) if (b & (1 << k)) missing.push(i * 8 + k);
        });
        return { kind: 'filereq', fileSrc, fileId, missing };
      }
      case PacketType.Range:
        return { kind: 'range', phase: r.u8() ? 'report' : 'request', session: r.u16(), intervalUs: r.u32() };
    }
  } catch {
    return null;
  }
  return null;
}
