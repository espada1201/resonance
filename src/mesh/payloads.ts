import { MAX_CHUNKS, MAX_FILE_BYTES } from './files';
import { PacketType } from './packet';

// Compact binary bodies. Every byte costs ~32 ms of airtime in the audible mode, so strings are
// length-prefixed UTF-8, coordinates are fixed-point and timestamps are whole seconds.

export type Status = 'safe' | 'help' | 'medical' | 'sheltering';
export const STATUSES: Status[] = ['safe', 'help', 'medical', 'sheltering'];
/** What someone asking for help needs (one bit each on air). */
export type Need = 'trapped' | 'injured' | 'medicine' | 'water' | 'food' | 'power' | 'transport' | 'shelter';
export const NEEDS: Need[] = ['trapped', 'injured', 'medicine', 'water', 'food', 'power', 'transport', 'shelter'];
/** What a contact card's owner can offer (one bit each on air). */
export type Skill = 'firstaid' | 'medical' | 'power' | 'water' | 'vehicle' | 'satphone' | 'language' | 'space';
export const SKILLS: Skill[] = ['firstaid', 'medical', 'power', 'water', 'vehicle', 'satphone', 'language', 'space'];
export type Topic = 'water' | 'food' | 'power' | 'medical' | 'shelter' | 'danger' | 'info';
export const TOPICS: Topic[] = ['water', 'food', 'power', 'medical', 'shelter', 'danger', 'info'];
/** A reply to a check-in: help is on the way, it is resolved, or a phone with signal passed it on outside. */
export type ReplyKind = 'coming' | 'resolved' | 'passed';
export const REPLIES: ReplyKind[] = ['coming', 'resolved', 'passed'];

export interface Geo {
  lat: number;
  lon: number;
  accuracyM: number;
}

export type Body =
  | { kind: 'text'; ts: number; nick: string; text: string }
  /**
   * `place` is where indoors ("Floor 4, room 412"); `about` names someone without a phone this check-in
   * is for; `outside` is a phone number or email that any device with signal may pass it on to.
   */
  | { kind: 'checkin'; ts: number; nick: string; status: Status; geo?: Geo; note: string; needs?: Need[]; place?: string; about?: string; outside?: string }
  | { kind: 'contact'; ts: number; name: string; phone: string; note: string; skills?: Skill[] }
  /** Refers to the check-in `src`:`msgId`. */
  | { kind: 'reply'; ts: number; nick: string; what: ReplyKind; src: number; msgId: number }
  /** Pinned news (water, charging, a blocked road) that stays up for `hours`. */
  | { kind: 'notice'; ts: number; nick: string; topic: Topic; hours: number; place: string; text: string }
  | { kind: 'file'; fileId: number; index: number; total: number; meta?: FileMeta; data: Uint8Array }
  | { kind: 'ack'; msgId: number; attempt: number }
  /** `hashes` and `bits` are a Bloom filter of the message ids the sender holds in slice `part` of `parts` (see bloom.ts). */
  | { kind: 'hello'; role: 'phone' | 'beacon'; nick: string; hashes: number; part: number; parts: number; bits: Uint8Array }
  | { kind: 'filereq'; fileSrc: number; fileId: number; missing: number[] }
  | { kind: 'range'; phase: 'request' | 'report'; session: number; intervalUs: number };

/** What the feed shows as its own item. */
export const CONTENT_KINDS = ['text', 'checkin', 'contact', 'notice'] as const;
export type ContentBody = Extract<Body, { kind: (typeof CONTENT_KINDS)[number] }>;
export const isContent = (b: Body): b is ContentBody => (CONTENT_KINDS as readonly string[]).includes(b.kind);

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
  reply: PacketType.Reply,
  notice: PacketType.Notice,
};

/** A set of options as a bit mask, in the order of `all`. */
const toBits = <T>(all: T[], some: T[] = []) => some.reduce((m, x) => m | (1 << all.indexOf(x)), 0);
const fromBits = <T>(all: T[], m: number) => (m ? all.filter((_, i) => m & (1 << i)) : undefined);

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
  /** UTF-8 to the end of the body: free text needs no length byte. */
  text(s: string) {
    return this.raw(new TextEncoder().encode(s));
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
  str(max: number) {
    return fitUtf8(new TextDecoder().decode(this.raw(this.u8())), max);
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
  text() {
    return new TextDecoder().decode(this.rest());
  }
}

/** The longest start of `s`, cut at a character boundary, whose UTF-8 fits in `max` bytes. */
export function fitUtf8(s: string, max: number): string {
  const enc = new TextEncoder();
  const chars = [...s];
  while (enc.encode(chars.join('')).length > max) chars.pop();
  return chars.join('');
}

/** Name fields are length-prefixed byte strings on air; inputs hold the same limits in bytes. */
export const MAX_NICK = 16;
export const MAX_CONTACT_NAME = 40;
export const MAX_CONTACT_PHONE = 24;
export const MAX_PLACE = 32;
/** A phone number or an email address. */
export const MAX_OUTSIDE = 40;
const MAX_FILE_NAME = 48;
const MAX_MIME = 40;
export const nowSec = () => Math.floor(Date.now() / 1000);

export function encodeBody(body: Body): Uint8Array {
  const w = new Writer();
  switch (body.kind) {
    case 'text':
      return w.u32(body.ts).str(body.nick, MAX_NICK).text(body.text).done();
    case 'checkin': {
      // One flag bit per optional field, in the order the fields follow.
      const needs = toBits(NEEDS, body.needs);
      const flags = (body.geo ? 1 : 0) | (needs ? 2 : 0) | (body.place ? 4 : 0) | (body.about ? 8 : 0) | (body.outside ? 16 : 0);
      w.u32(body.ts).u8(STATUSES.indexOf(body.status)).u8(flags);
      if (body.geo) {
        w.i32(Math.round(body.geo.lat * 1e5)).i32(Math.round(body.geo.lon * 1e5));
        w.u16(Math.min(65535, Math.round(body.geo.accuracyM)));
      }
      if (needs) w.u8(needs);
      if (body.place) w.str(body.place, MAX_PLACE);
      if (body.about) w.str(body.about, MAX_CONTACT_NAME);
      if (body.outside) w.str(body.outside, MAX_OUTSIDE);
      return w.str(body.nick, MAX_NICK).text(body.note).done();
    }
    case 'contact':
      return w.u32(body.ts).str(body.name, MAX_CONTACT_NAME).str(body.phone, MAX_CONTACT_PHONE).u8(toBits(SKILLS, body.skills)).text(body.note).done();
    case 'reply':
      return w.u32(body.ts).u8(REPLIES.indexOf(body.what)).u24(body.src).u32(body.msgId).str(body.nick, MAX_NICK).done();
    case 'notice':
      return w.u32(body.ts).u8(TOPICS.indexOf(body.topic)).u8(body.hours).str(body.nick, MAX_NICK).str(body.place, MAX_PLACE).text(body.text).done();
    case 'file':
      w.u16(body.fileId).u8(body.index).u8(body.total);
      if (body.index === 0) {
        const m = body.meta ?? { name: 'file', mime: '', size: 0 };
        w.str(m.name, MAX_FILE_NAME).str(m.mime, MAX_MIME).u16(m.size);
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
        return { kind: 'text', ts: r.u32(), nick: r.str(MAX_NICK), text: r.text() };
      case PacketType.CheckIn: {
        const ts = r.u32();
        const status = STATUSES[r.u8()];
        if (!status) return null;
        const flags = r.u8();
        const geo = flags & 1 ? { lat: r.i32() / 1e5, lon: r.i32() / 1e5, accuracyM: r.u16() } : undefined;
        const needs = flags & 2 ? fromBits(NEEDS, r.u8()) : undefined;
        const place = flags & 4 ? r.str(MAX_PLACE) : undefined;
        const about = flags & 8 ? r.str(MAX_CONTACT_NAME) : undefined;
        const outside = flags & 16 ? r.str(MAX_OUTSIDE) : undefined;
        return { kind: 'checkin', ts, status, geo, needs, place, about, outside, nick: r.str(MAX_NICK), note: r.text() };
      }
      case PacketType.Contact:
        return { kind: 'contact', ts: r.u32(), name: r.str(MAX_CONTACT_NAME), phone: r.str(MAX_CONTACT_PHONE), skills: fromBits(SKILLS, r.u8()), note: r.text() };
      case PacketType.Reply: {
        const reply = { kind: 'reply' as const, ts: r.u32(), what: REPLIES[r.u8()], src: r.u24(), msgId: r.u32(), nick: r.str(MAX_NICK) };
        return reply.what ? reply : null;
      }
      case PacketType.Notice:
        return { kind: 'notice', ts: r.u32(), topic: TOPICS[r.u8()] ?? 'info', hours: r.u8(), nick: r.str(MAX_NICK), place: r.str(MAX_PLACE), text: r.text() };
      case PacketType.FileChunk: {
        const fileId = r.u16();
        const index = r.u8();
        const total = r.u8();
        const meta = index === 0 ? { name: r.str(MAX_FILE_NAME), mime: r.str(MAX_MIME), size: r.u16() } : undefined;
        if (total > MAX_CHUNKS || (meta && meta.size > MAX_FILE_BYTES)) return null;
        return { kind: 'file', fileId, index, total, meta, data: r.rest() };
      }
      case PacketType.Ack:
        return { kind: 'ack', msgId: r.u32(), attempt: r.u8() };
      case PacketType.Hello: {
        const role = r.u8() ? 'beacon' : 'phone';
        const nick = r.str(MAX_NICK);
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
