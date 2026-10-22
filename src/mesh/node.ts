import { Bloom, sliceOf } from './bloom';
import { BROADCAST, type Packet, PacketType, decodePacket, encodePacket } from './packet';
import { decodeBody, encodeBody } from './payloads';

// Store-and-forward flooding for a broadcast medium where every transmission is heard by every
// neighbour. Relays wait a random backoff and cancel if they overhear enough copies first
// (counter-based suppression), so a crowd of phones does not all shout the same packet.
// Direct messages ask for an ACK and are retried with a fresh attempt number.
// Nodes periodically announce what they hold (HELLO); neighbours push back what is missing,
// which is what lets a message ride in someone's pocket from one room to the next. A pushed
// ("carried") packet goes out one hop deep, so nobody mistakes the carrier for the author.

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
  carryCooldownMs: number;
  /** A broadcast nobody repeats within this window is sent once more (passive acknowledgement). */
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
  carryCooldownMs: 10 * 60_000,
  echoTimeoutMs: 20_000,
};

export interface StoredPacket {
  bytes: Uint8Array;
  firstHeard: number;
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
}

interface PendingAck {
  packet: Packet;
  due: number;
}

/** Neighbours missing the same file chunk tend to ask at once; answer the burst once. */
const ANSWER_COOLDOWN_MS = 15_000;
/** A HELLO's Bloom filter covers this many ids; bigger stores are summarised a slice at a time. */
const HELLO_SLICE = 40;
/** A neighbour silent this long counts as new when it says hello again. */
const MET_AFTER_MS = 10 * 60_000;
/** Packets heard more recently than this are probably still spreading through the room the newcomer just walked into. */
const SETTLED_MS = 60_000;

export const storeKey = (p: Pick<Packet, 'src' | 'msgId'>) => `${p.src}:${p.msgId}`;
const relayKey = (p: Packet) => `${p.src}:${p.msgId}:${p.attempt}`;

export class MeshNode {
  readonly store = new Map<string, StoredPacket>();
  readonly neighbors = new Map<number, Neighbor>();
  readonly stats = { heard: 0, delivered: 0, relayed: 0, suppressed: 0, carried: 0 };
  readonly config: MeshConfig = { ...DEFAULT_CONFIG };
  private readonly seen = new Map<string, number>();
  private readonly delivered = new Set<string>();
  private relays: PendingRelay[] = [];
  private acks = new Map<number, PendingAck>();
  private echoes = new Map<number, PendingAck>();
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
    this.delivered.add(storeKey(packet));
    if (this.isStorable(packet)) this.remember(packet, true);
    // Retry timers start once the frame has actually been on air (see aired()).
    if (packet.ackRequested && packet.dst !== BROADCAST) {
      this.acks.set(packet.msgId, { packet, due: Infinity });
    } else if (packet.dst === BROADCAST && packet.ttl > 1 && this.isStorable(packet)) {
      this.echoes.set(packet.msgId, { packet, due: Infinity });
    }
    this.events.transmit(encodePacket(packet), reason);
    return packet;
  }

  /**
   * The radio has finished playing (or given up on) a frame. Retry timers count from here, not
   * from when the frame was queued: it may have waited behind a whole file.
   */
  aired(bytes: Uint8Array) {
    const p = decodePacket(bytes);
    if (!p || p.src !== this.id) return;
    const now = this.clock.now();
    const s = this.store.get(storeKey(p));
    if (s) s.queued = false;
    const a = this.acks.get(p.msgId);
    if (a && a.packet.attempt === p.attempt) a.due = now + this.ackTimeout(p);
    const e = this.echoes.get(p.msgId);
    if (e && p.attempt === 0) e.due = now + this.echoTimeout();
  }

  /** Feeds bytes decoded off the air. Returns the parsed packet, or null for junk. */
  receive(bytes: Uint8Array): Packet | null {
    const p = decodePacket(bytes);
    if (!p) return p;
    const rk = relayKey(p);
    const sk = storeKey(p);
    // Any copy of a packet makes our answer or carry of it redundant; a relay, only the same attempt.
    for (const r of this.relays) if (r.key === rk || r.key === sk) r.heard++;
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
    if (this.seen.has(rk)) return p;
    this.seen.set(rk, now);
    this.pruneSeen(now);

    if (p.type === PacketType.Ack) this.onAck(p);
    if (p.type === PacketType.Hello && p.hops === 0) {
      this.onHello(p, newcomer);
      this.events.heardHello?.(newcomer);
    }
    const forMe = p.dst === BROADCAST || p.dst === this.id;
    if (forMe && p.type !== PacketType.Ack && p.type !== PacketType.Hello && !this.delivered.has(sk)) {
      this.delivered.add(sk);
      this.stats.delivered++;
      this.events.deliver(p);
    }
    if (p.dst === this.id && p.ackRequested && (this.events.readable?.(p) ?? true)) this.sendAck(p);
    if (this.isStorable(p)) this.remember(p);
    if (this.config.relay && p.dst !== this.id) this.schedule(p, rk, 'relay');
    return p;
  }

  /**
   * Announces this node with a summary of what it holds. Bigger stores are split into slices by
   * message id and each HELLO summarises the next slice, so over a few HELLOs a neighbour sees
   * everything, and never mistakes "not in this slice" for "missing".
   */
  hello(nick: string, role: 'phone' | 'beacon') {
    const msgId = (this.clock.random() * 2 ** 32) >>> 0;
    const held = [...this.store.values()].map((s) => decodePacket(s.bytes)!.msgId);
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

  /**
   * A neighbour said hello: push it up to three stored packets its summary's slice lacks, newest
   * first. Someone just arrived from elsewhere is also offered our newest news outside that slice:
   * it most likely lacks it, and waiting for its summaries to cycle round could take an hour.
   * Every holder in earshot offers; the first copy on air stands the others down.
   */
  private onHello(p: Packet, newcomer: boolean) {
    const body = decodeBody(PacketType.Hello, p.body);
    if (body?.kind !== 'hello') return;
    const src = p.src;
    const now = this.clock.now();
    this.touchNeighbor(src, now, body.nick, body.role);
    const theirs = new Bloom(body.hashes, body.bits, p.msgId);
    const covered = (id: number) => sliceOf(id, body.parts) === body.part;
    for (const id of this.echoes.keys()) if (covered(id) && theirs.has(id)) this.echoes.delete(id);
    const offers = [...this.store.values()]
      .map((s) => ({ s, p: decodePacket(s.bytes)! }))
      .filter(({ s, p }) => p.src !== src && !s.queued && !theirs.has(p.msgId) && now - s.lastPushed > this.config.carryCooldownMs)
      .filter(({ s, p }) => covered(p.msgId) || (newcomer && now - s.firstHeard > SETTLED_MS))
      .filter(({ p }) => p.dst === BROADCAST || p.dst === src)
      .sort((a, b) => Number(b.p.dst === src) - Number(a.p.dst === src) || b.s.firstHeard - a.s.firstHeard)
      .slice(0, 3);
    for (const { s, p } of offers) if (this.schedule(p, storeKey(p), 'carry')) s.lastPushed = now;
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
      for (const r of this.relays) if (r.due <= now) r.due = now + lo + this.clock.random() * (hi - lo);
    }
    const due = this.relays.filter((r) => r.due <= now);
    this.relays = this.relays.filter((r) => r.due > now);
    for (const r of due) {
      if (r.heard >= r.quorum) {
        this.stats.suppressed++;
        continue;
      }
      if (r.reason === 'relay') this.stats.relayed++;
      if (r.reason === 'carry') this.stats.carried++;
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
      a.due = Infinity;
      this.seen.set(relayKey(a.packet), now);
      this.events.transmit(encodePacket(a.packet), 'retry');
    }
    for (const [id, e] of this.echoes) {
      if (e.due > now) continue;
      // One repeat only: a lone device should not keep shouting into an empty room.
      this.echoes.delete(id);
      const again = { ...e.packet, attempt: 1 };
      this.seen.set(relayKey(again), now);
      this.events.transmit(encodePacket(again), 'retry');
    }
    for (const [k, s] of this.store) if (now - s.firstHeard > this.config.storeTtlMs) this.store.delete(k);
  }

  /** Restores packets persisted from an earlier session. */
  hydrate(saved: StoredPacket[]) {
    for (const s of saved) {
      const p = decodePacket(s.bytes);
      if (!p) continue;
      this.store.set(storeKey(p), s);
      this.seen.set(relayKey(p), s.firstHeard);
      this.delivered.add(storeKey(p));
    }
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

  /**
   * Queues a copy of `p` one hop deeper, after a random backoff; `distance` adds whole backoff
   * windows. False if the packet has no hops left.
   */
  private schedule(p: Packet, key: string, reason: PendingRelay['reason'], distance = 0) {
    if (p.hops + 1 >= p.ttl) return false;
    const [lo, hi] = this.config.backoffMs;
    this.relays.push({
      key,
      msgId: p.msgId,
      due: this.clock.now() + distance * hi + lo + this.clock.random() * (hi - lo),
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
    this.store.set(k, { bytes: encodePacket({ ...p, hops: 0, attempt: 0 }), firstHeard: this.clock.now(), lastPushed: -Infinity, queued });
    if (this.store.size > this.config.storeLimit) {
      const oldest = [...this.store.entries()].sort((a, b) => a[1].firstHeard - b[1].firstHeard)[0];
      this.store.delete(oldest[0]);
    }
  }

  private touchNeighbor(id: number, now: number, nick?: string, role?: 'phone' | 'beacon') {
    const n = this.neighbors.get(id) ?? { id, lastHeard: now };
    n.lastHeard = now;
    if (nick) n.nick = nick;
    if (role) n.role = role;
    this.neighbors.set(id, n);
  }

  private pruneSeen(now: number) {
    if (this.seen.size < 4000) return;
    for (const [k, t] of this.seen) if (now - t > this.config.storeTtlMs) this.seen.delete(k);
  }
}
