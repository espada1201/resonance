import { type CheckInBody, type Heard, superseded } from '../roster';
import { Bloom, sliceOf } from './bloom';
import { BROADCAST, type Packet, PacketType, decodePacket, encodePacket, peekType } from './packet';
import { decodeBody, encodeBody } from './payloads';
import { MAX_DEFER_MS } from './radio';

// Store-and-forward flooding for a broadcast medium where every transmission is heard by every
// neighbour. Relays wait a random backoff and cancel if they overhear enough copies first
// (counter-based suppression), so a crowd of phones does not all shout the same packet.
// Direct messages ask for an ACK and are retried with a fresh attempt number.
// Nodes periodically announce what they hold (HELLO); neighbours push back what is missing,
// a few at once and the rest whenever the air is free, which is what lets a message ride in
// someone's pocket from one room to the next. A pushed ("carried") packet goes out one hop deep,
// so nobody mistakes the carrier for the author.

export interface MeshClock {
  now(): number;
  random(): number;
}

interface MeshConfig {
  relay: boolean;
  backoffMs: [number, number];
  suppressAfter: number;
  ackTimeoutMs: number;
  maxAttempts: number;
  storeLimit: number;
  storeTtlMs: number;
  /** How long lasting news (check-ins, replies, notices) is kept and carried: an outage runs for days. */
  lastingTtlMs: number;
  /** A packet pushed to a neighbour is not pushed again this soon: it is still on its way. */
  carryCooldownMs: number;
  /** A broadcast nobody repeats within this window is sent again (passive acknowledgement). */
  echoTimeoutMs: number;
}

const DEFAULT_CONFIG: MeshConfig = {
  relay: true,
  backoffMs: [600, 4000],
  suppressAfter: 2,
  ackTimeoutMs: 45_000,
  maxAttempts: 3,
  storeLimit: 300,
  storeTtlMs: 12 * 3600_000,
  lastingTtlMs: 72 * 3600_000,
  carryCooldownMs: 90_000,
  echoTimeoutMs: 20_000,
};

export interface StoredPacket {
  bytes: Uint8Array;
  firstHeard: number;
  /** Its hop count when first heard: `bytes` keeps it at 0. */
  hops: number;
  lastPushed: number;
  /** One of ours that has not been on air yet. */
  queued?: boolean;
}

interface Neighbor {
  id: number;
  lastHeard: number;
  nick?: string;
  role?: 'phone' | 'beacon';
}

interface MeshEvents {
  /** Hand a finished packet to the radio. */
  transmit(bytes: Uint8Array, reason: 'origin' | 'relay' | 'carry' | 'answer' | 'ack' | 'retry'): void;
  /** A packet for this node (or everyone) arrived for the first time. */
  deliver(p: Packet): void;
  /** A direct message was acknowledged, or gave up after maxAttempts. */
  delivery?(msgId: number, ok: boolean): void;
  /** True while another node is on air; due relays wait so they can overhear it first. */
  channelBusy?(): boolean;
  /** Whether this node can open a packet; only readable direct messages are acknowledged. */
  readable?(p: Packet): boolean;
  /** A neighbour said hello; `newcomer` if we had not heard it for a while (a chance to say hello back). */
  heardHello?(newcomer: boolean): void;
}

interface PendingRelay {
  /** A relay is of one attempt (relayKey); an answer or carry is of the packet itself (storeKey). */
  key: string;
  msgId: number;
  due: number;
  heard: number;
  /** Copies overheard before ours is due that make ours redundant. */
  quorum: number;
  reason: 'relay' | 'answer' | 'carry';
  bytes: Uint8Array;
  /** When busy air first held it back. */
  heldSince?: number;
}

interface PendingAck {
  packet: Packet;
  due: number;
}

interface Feed {
  queue: string[];
  unchecked: number[];
  pushesArrive: boolean;
}

/** Neighbours missing the same file chunk tend to ask at once; answer the burst once. */
const ANSWER_COOLDOWN_MS = 15_000;
/** A HELLO's Bloom filter covers this many ids; bigger stores are summarised a slice at a time. */
export const HELLO_SLICE = 40;
/** A neighbour silent this long counts as new when it says hello again. */
const MET_AFTER_MS = 10 * 60_000;
/** Packets heard more recently than this are probably still spreading through the room the newcomer just walked into. */
const SETTLED_MS = 60_000;
/** Packets pushed at once to a neighbour that says hello; the rest follow while the air is free. */
const CARRY_BATCH = 3;
/** Most packets pushed to a neighbour before its next hello shows that our pushes reach it. */
const UNPROVEN_FEED = 15;
/** A carry handed to the radio this long ago has finished on air or been dropped (longest frame plus deferral). */
const CARRY_AIRED_MS = 60_000;
/** Tries a broadcast nobody echoes gets with no neighbour in earshot: it should not keep shouting into an empty room. */
const ALONE_TRIES = 2;
/** When the store overflows, lasting news beyond this share of it makes room; within it, chat and file chunks do. */
const LASTING_SHARE = 4 / 5;
/** The due time of an answer awaited for a frame still waiting to go on air: aired() starts the timer. */
const NOT_AIRED = Infinity;

/** Check-ins, the replies to them and notices: someone who turns up on day two still learns who checked in on day one. */
const LASTING = new Set<PacketType | null>([PacketType.CheckIn, PacketType.Reply, PacketType.Notice]);
export const isLasting = (bytes: Uint8Array) => LASTING.has(peekType(bytes));

export const storeKey = (p: Pick<Packet, 'src' | 'msgId'>) => `${p.src}:${p.msgId}`;
const relayKey = (p: Packet) => `${p.src}:${p.msgId}:${p.attempt}`;
const wantsReceipt = (p: Packet) => p.ackRequested && p.dst !== BROADCAST;

/**
 * The oldest check-in in `lasting` (oldest first) that a newer one from the same device about the same
 * person supersedes. A sealed one cannot be read, so it never counts as superseded; one a reply answers
 * stays, or newcomers would get the reply answering nothing.
 */
function supersededCheckIn(lasting: Array<[string, StoredPacket]>) {
  const news = lasting.map(([, s]) => readable(s)).filter((h) => h !== null);
  const answered = new Set(news.map((h) => h.body).filter((b) => b.kind === 'reply').map(storeKey));
  const checkIns = news.filter((h): h is Heard<CheckInBody> => h.body.kind === 'checkin');
  return superseded(checkIns).map(storeKey).find((k) => !answered.has(k));
}

/** What a stored packet says, as the roster would hold it; null if it is sealed or garbled. */
function readable(s: StoredPacket): Heard | null {
  const p = decodePacket(s.bytes)!;
  const body = p.encrypted ? null : decodeBody(p.type, p.body);
  return body && { src: p.src, msgId: p.msgId, at: s.firstHeard, hops: s.hops, encrypted: false, body };
}

export class MeshNode {
  readonly store = new Map<string, StoredPacket>();
  readonly neighbors = new Map<number, Neighbor>();
  readonly stats = { heard: 0, delivered: 0, relayed: 0, suppressed: 0, carried: 0 };
  readonly config: MeshConfig = { ...DEFAULT_CONFIG };
  private readonly seen = new Map<string, number>();
  /** When each packet was handed to the app, so a retry of it is not handed over twice. */
  private readonly delivered = new Map<string, number>();
  /** Packets our store forgot that a neighbour carried back, by msgId: our hellos list them, or they come back at every one. */
  private readonly forgotten = new Map<number, number>();
  private relays: PendingRelay[] = [];
  private acks = new Map<number, PendingAck>();
  private echoes = new Map<number, PendingAck>();
  private feeds = new Map<number, Feed>();
  /** Carries handed to the radio and not yet aired: the next batch waits for them. */
  private carrying = new Map<Uint8Array, number>();
  private hellos = 0;

  constructor(
    readonly id: number,
    private readonly clock: MeshClock,
    private readonly events: MeshEvents,
  ) {}

  /** Sends a packet this node authored. src/hops/attempt are filled in here. */
  originate(p: Omit<Packet, 'src' | 'hops' | 'attempt'>, reason: 'origin' | 'ack' = 'origin'): Packet {
    const packet: Packet = { ...p, src: this.id, hops: 0, attempt: 0 };
    this.seen.set(relayKey(packet), this.clock.now());
    this.delivered.set(storeKey(packet), this.clock.now());
    this.pruneSeen(this.clock.now());
    if (this.isStorable(packet)) this.remember(packet, true);
    this.awaitAnswer(packet);
    this.events.transmit(encodePacket(packet), reason);
    return packet;
  }

  private awaitAnswer(packet: Packet) {
    if (wantsReceipt(packet)) {
      this.acks.set(packet.msgId, { packet, due: NOT_AIRED });
    } else if (packet.dst === BROADCAST && packet.ttl > 1 && this.isStorable(packet)) {
      this.echoes.set(packet.msgId, { packet, due: NOT_AIRED });
    }
  }

  /**
   * The radio has finished playing (or given up on) a frame. Retry timers count from here, not
   * from when the frame was queued: it may have waited behind a whole file.
   */
  aired(bytes: Uint8Array) {
    this.carrying.delete(bytes);
    const p = decodePacket(bytes);
    if (!p || p.src !== this.id) return;
    const now = this.clock.now();
    const s = this.store.get(storeKey(p));
    if (s) s.queued = false;
    const a = this.acks.get(p.msgId);
    if (a && a.packet.attempt === p.attempt) a.due = now + this.ackTimeout(p);
    const e = this.echoes.get(p.msgId);
    if (e && e.packet.attempt === p.attempt) e.due = now + this.echoTimeout();
  }

  /** Feeds bytes decoded off the air. Returns the parsed packet, or null for junk. */
  receive(bytes: Uint8Array): Packet | null {
    const p = decodePacket(bytes);
    if (!p) return p;
    const rk = relayKey(p);
    const sk = storeKey(p);
    // Any copy of a packet makes our answer or carry of it redundant; a relay, only the same attempt.
    for (const r of this.relays) if (r.key === rk || r.key === sk) r.heard++;
    for (const f of this.feeds.values()) if (f.queue.includes(sk)) f.queue = f.queue.filter((k) => k !== sk);
    // Someone repeated our broadcast: it made it out.
    if (p.src === this.id) {
      this.echoes.delete(p.msgId);
      return p;
    }
    const now = this.clock.now();
    this.stats.heard++;
    const known = this.neighbors.get(p.src);
    const newcomer = !known || now - known.lastHeard > MET_AFTER_MS;
    if (p.hops === 0) this.touchNeighbor(p.src, now);

    // Another copy of something we already have (and acknowledged, if it was for us). A retry
    // carries a new attempt number, so it is not a copy.
    if (this.seen.has(rk)) {
      if (this.isStorable(p) && !this.store.has(sk)) this.forgotten.set(p.msgId, now);
      return p;
    }
    this.seen.set(rk, now);
    this.pruneSeen(now);

    if (p.type === PacketType.Ack) this.onAck(p);
    if (p.type === PacketType.Hello && p.hops === 0) {
      this.onHello(p, newcomer);
      this.events.heardHello?.(newcomer);
    }
    const forMe = p.dst === BROADCAST || p.dst === this.id;
    if (forMe && p.type !== PacketType.Ack && p.type !== PacketType.Hello && !this.delivered.has(sk)) {
      this.delivered.set(sk, now);
      this.stats.delivered++;
      this.events.deliver(p);
    }
    if (p.dst === this.id && p.ackRequested && (this.events.readable?.(p) ?? true)) this.sendAck(p);
    if (this.isStorable(p)) this.remember(p);
    if (this.config.relay && p.dst !== this.id) this.schedule(p, rk, 'relay', wantsReceipt(p) ? 1 : 0);
    return p;
  }

  /**
   * Announces this node with a summary of what it holds. Bigger stores are split into slices by
   * message id and each HELLO summarises the next slice, so over a few HELLOs a neighbour sees
   * everything, and never mistakes "not in this slice" for "missing".
   */
  hello(nick: string, role: 'phone' | 'beacon') {
    const msgId = (this.clock.random() * 2 ** 32) >>> 0;
    const held = [...[...this.store.values()].map((s) => decodePacket(s.bytes)!.msgId), ...this.forgotten.keys()];
    const parts = Math.max(1, Math.ceil(held.length / HELLO_SLICE));
    const part = this.hellos++ % parts;
    const have = Bloom.of(held.filter((id) => sliceOf(id, parts) === part), msgId);
    return this.originate({
      type: PacketType.Hello,
      encrypted: false,
      ackRequested: false,
      msgId,
      dst: BROADCAST,
      ttl: 1,
      channel: 0,
      body: encodeBody({ kind: 'hello', role, nick, hashes: have.hashes, part, parts, bits: have.bits }),
    });
  }

  private onAck(p: Packet) {
    const body = decodeBody(PacketType.Ack, p.body);
    if (body?.kind !== 'ack') return;
    // The message reached its destination: anyone still holding a relay of it can stand down.
    this.relays = this.relays.filter((r) => r.msgId !== body.msgId);
    if (p.dst !== this.id) return;
    // Also after we gave up, or after a reload forgot the retry timer: it arrived all the same.
    this.acks.delete(body.msgId);
    this.events.delivery?.(body.msgId, true);
  }

  private onHello(p: Packet, newcomer: boolean) {
    const body = decodeBody(PacketType.Hello, p.body);
    if (body?.kind !== 'hello') return;
    const src = p.src;
    const now = this.clock.now();
    this.touchNeighbor(src, now, body.nick, body.role);
    const theirs = new Bloom(body.hashes, body.bits, p.msgId);
    const covered = (id: number) => sliceOf(id, body.parts) === body.part;
    for (const id of this.echoes.keys()) if (covered(id) && theirs.has(id)) this.echoes.delete(id);
    const before = this.feeds.get(src);
    const checked = before?.unchecked.filter(covered) ?? [];
    const pushesArrive = checked.length ? checked.some((id) => theirs.has(id)) : (before?.pushesArrive ?? false);
    const firstContact = !before;
    const budget = firstContact ? UNPROVEN_FEED : pushesArrive ? Infinity : CARRY_BATCH;
    const lacking = this.lackedBy(src, theirs, covered, newcomer, now);
    // Only what the summary shows missing is worth the air later; the newcomer guesses go now or never.
    const later = lacking
      .slice(CARRY_BATCH)
      .filter(({ p }) => covered(p.msgId))
      .slice(0, budget - CARRY_BATCH);
    this.feeds.set(src, { queue: later.map(({ p }) => storeKey(p)), unchecked: before?.unchecked.filter((id) => !covered(id)) ?? [], pushesArrive });
    for (const { s, p } of lacking.slice(0, CARRY_BATCH)) this.carry(src, s, p, now);
  }

  /** What we hold that a neighbour's summary lacks, for it first and then newest first. */
  private lackedBy(src: number, theirs: Bloom, covered: (id: number) => boolean, newcomer: boolean, now: number) {
    return [...this.store.values()]
      .map((s) => ({ s, p: decodePacket(s.bytes)! }))
      .filter(({ s, p }) => p.src !== src && !s.queued && !theirs.has(p.msgId) && now - s.lastPushed > this.config.carryCooldownMs)
      .filter(({ s, p }) => covered(p.msgId) || (newcomer && now - s.firstHeard > SETTLED_MS))
      .filter(({ p }) => p.dst === BROADCAST || p.dst === src)
      .sort((a, b) => Number(b.p.dst === src) - Number(a.p.dst === src) || b.s.firstHeard - a.s.firstHeard);
  }

  private carry(to: number, s: StoredPacket, p: Packet, now: number) {
    if (!this.schedule(p, storeKey(p), 'carry')) return;
    s.lastPushed = now;
    this.feeds.get(to)?.unchecked.push(p.msgId);
  }

  /**
   * Pushes the next few packets a neighbour still lacks, once our last ones have been on air and
   * nobody else is talking, so feeding a newcomer never crowds out live traffic. Stops for a
   * neighbour we have not heard for a while: it walked away.
   */
  private feedNeighbors(now: number) {
    for (const [bytes, at] of this.carrying) if (now - at > CARRY_AIRED_MS) this.carrying.delete(bytes);
    if (this.carrying.size || this.relays.some((r) => r.reason === 'carry') || this.events.channelBusy?.()) return;
    for (const [id, feed] of this.feeds) {
      if (now - (this.neighbors.get(id)?.lastHeard ?? -Infinity) > MET_AFTER_MS) {
        this.feeds.delete(id);
        continue;
      }
      const next = feed.queue.splice(0, CARRY_BATCH).map((k) => this.store.get(k)).filter((s) => s !== undefined);
      for (const s of next) this.carry(id, s, decodePacket(s.bytes)!, now);
      if (next.length) return;
    }
  }

  /**
   * Someone asked for a packet we hold (a missing file chunk). Answer after a random backoff,
   * unless another holder answers first. A holder that heard the request through relays
   * (`requestHops`) waits longer, so the holder nearest the asker answers; if none near it has
   * the packet, the farther answer still arrives, since a relay missing it passes it on.
   * At most once per ANSWER_COOLDOWN_MS, and never for one of ours still in the transmit queue.
   */
  answer(src: number, msgId: number, requestHops = 0): boolean {
    const k = storeKey({ src, msgId });
    const s = this.store.get(k);
    const now = this.clock.now();
    if (!s || s.queued || now - s.lastPushed < ANSWER_COOLDOWN_MS) return false;
    if (!this.schedule(decodePacket(s.bytes)!, k, 'answer', requestHops)) return false;
    s.lastPushed = now;
    return true;
  }

  /** Runs due timers. Call a few times per second. */
  tick() {
    const now = this.clock.now();
    const [lo, hi] = this.config.backoffMs;
    if (this.events.channelBusy?.()) {
      // Held no longer than the radio holds our own frames: carrier sense can be fooled for hours.
      for (const r of this.relays) if (r.due <= now && now - (r.heldSince ??= now) < MAX_DEFER_MS) r.due = now + lo + this.clock.random() * (hi - lo);
    }
    const due = this.relays.filter((r) => r.due <= now);
    this.relays = this.relays.filter((r) => r.due > now);
    for (const r of due) {
      if (r.heard >= r.quorum) {
        this.stats.suppressed++;
        continue;
      }
      if (r.reason === 'relay') this.stats.relayed++;
      if (r.reason === 'carry') {
        this.stats.carried++;
        this.carrying.set(r.bytes, now);
      }
      this.events.transmit(r.bytes, r.reason);
    }
    for (const [id, a] of this.acks) {
      if (a.due > now) continue;
      if (a.packet.attempt + 1 >= this.config.maxAttempts) {
        this.acks.delete(id);
        this.events.delivery?.(id, false);
        continue;
      }
      a.packet = { ...a.packet, attempt: a.packet.attempt + 1 };
      a.due = NOT_AIRED;
      this.seen.set(relayKey(a.packet), now);
      this.events.transmit(encodePacket(a.packet), 'retry');
    }
    for (const [id, e] of this.echoes) {
      if (e.due > now) continue;
      e.packet = { ...e.packet, attempt: e.packet.attempt + 1 };
      e.due = NOT_AIRED;
      if (e.packet.attempt + 1 >= (this.alone(now) ? ALONE_TRIES : this.config.maxAttempts)) this.echoes.delete(id);
      this.seen.set(relayKey(e.packet), now);
      this.events.transmit(encodePacket(e.packet), 'retry');
    }
    for (const [k, s] of this.store) if (now - s.firstHeard > this.keepMs(s.bytes)) this.store.delete(k);
    this.feedNeighbors(now);
  }

  private keepMs(bytes: Uint8Array) {
    return isLasting(bytes) ? this.config.lastingTtlMs : this.config.storeTtlMs;
  }

  /**
   * Restores packets persisted from an earlier session. Ours that had not been on air yet go now,
   * unless they are past keeping; returns their keys.
   */
  hydrate(saved: StoredPacket[]) {
    const resent = new Set<string>();
    for (const s of saved) {
      const p = decodePacket(s.bytes);
      if (!p) continue;
      const k = storeKey(p);
      this.store.set(k, s);
      this.seen.set(relayKey(p), s.firstHeard);
      this.delivered.set(k, s.firstHeard);
      if (s.queued && p.src === this.id && this.clock.now() - s.firstHeard <= this.keepMs(s.bytes)) {
        this.awaitAnswer(p);
        this.events.transmit(s.bytes, 'origin');
        resent.add(k);
      }
    }
    return resent;
  }

  private echoTimeout() {
    return this.config.echoTimeoutMs + this.clock.random() * 8000;
  }

  private ackTimeout(p: Packet) {
    return this.config.ackTimeoutMs * (1 + p.attempt * 0.5) + this.clock.random() * 5000;
  }

  private sendAck(p: Packet) {
    this.originate({
      type: PacketType.Ack,
      encrypted: false,
      ackRequested: false,
      msgId: (this.clock.random() * 2 ** 32) >>> 0,
      dst: p.src,
      ttl: p.ttl,
      channel: 0,
      body: encodeBody({ kind: 'ack', msgId: p.msgId, attempt: p.attempt }),
    }, 'ack');
  }

  /** Queues a copy of `p` one hop deeper, after a random backoff and `extraWindows` whole ones more. False if the packet has no hops left. */
  private schedule(p: Packet, key: string, reason: PendingRelay['reason'], extraWindows = 0) {
    if (p.hops + 1 >= p.ttl) return false;
    const [lo, hi] = this.config.backoffMs;
    this.relays.push({
      key,
      msgId: p.msgId,
      due: this.clock.now() + extraWindows * hi + lo + this.clock.random() * (hi - lo),
      heard: 0,
      quorum: reason === 'relay' ? this.config.suppressAfter : 1,
      reason,
      bytes: encodePacket({ ...p, hops: p.hops + 1 }),
    });
    return true;
  }

  private isStorable(p: Packet) {
    return p.type !== PacketType.Ack && p.type !== PacketType.Hello && p.type !== PacketType.FileRequest && p.type !== PacketType.Range;
  }

  private remember(p: Packet, queued = false) {
    const k = storeKey(p);
    if (this.store.has(k)) return;
    this.store.set(k, { bytes: encodePacket({ ...p, hops: 0, attempt: 0 }), firstHeard: this.clock.now(), hops: p.hops, lastPushed: -Infinity, queued });
    if (this.store.size > this.config.storeLimit) this.store.delete(this.leastNeeded());
  }

  /**
   * What a full store forgets: the oldest chat or file chunk while lasting news fits its share. Past
   * that, a superseded check-in goes before the oldest lasting news, so one person's only check-in is
   * not lost to everyone else checking in again.
   */
  private leastNeeded() {
    const oldestFirst = [...this.store].sort(([, a], [, b]) => a.firstHeard - b.firstHeard);
    const lasting = oldestFirst.filter(([, s]) => isLasting(s.bytes));
    if (lasting.length <= this.config.storeLimit * LASTING_SHARE) return oldestFirst.find(([, s]) => !isLasting(s.bytes))![0];
    return supersededCheckIn(lasting) ?? lasting[0][0];
  }

  private alone(now: number) {
    return ![...this.neighbors.values()].some((n) => now - n.lastHeard < MET_AFTER_MS);
  }

  private touchNeighbor(id: number, now: number, nick?: string, role?: 'phone' | 'beacon') {
    const n = this.neighbors.get(id) ?? { id, lastHeard: now };
    n.lastHeard = now;
    if (nick) n.nick = nick;
    if (role) n.role = role;
    this.neighbors.set(id, n);
  }

  /**
   * Dedupe memory outlives everything stored, so a late copy of something we hold is not relayed
   * again. Deliveries, forgotten packets and neighbours go with it: a beacon runs for days.
   */
  private pruneSeen(now: number) {
    if (this.seen.size < 4000) return;
    const keep = Math.max(this.config.storeTtlMs, this.config.lastingTtlMs);
    for (const [k, t] of this.seen) if (now - t > keep) this.seen.delete(k);
    for (const [k, t] of this.delivered) if (now - t > keep) this.delivered.delete(k);
    for (const [id, t] of this.forgotten) if (now - t > keep) this.forgotten.delete(id);
    for (const [id, n] of this.neighbors) if (now - n.lastHeard > keep) this.neighbors.delete(id);
  }
}
