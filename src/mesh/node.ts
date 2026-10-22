import { Bloom, MAX_BLOOM_IDS } from './bloom';
import { BROADCAST, type Packet, PacketType, decodePacket, encodePacket } from './packet';
import { decodeBody, encodeBody } from './payloads';

// Store-and-forward flooding for a broadcast medium where every transmission is heard by every
// neighbour. Relays wait a random backoff and cancel if they overhear enough copies first
// (counter-based suppression), so a crowd of phones does not all shout the same packet.
// Direct messages ask for an ACK and are retried with a fresh attempt number.
// Nodes periodically announce what they hold (HELLO); neighbours push back what is missing,
// which is what lets a message ride in someone's pocket from one room to the next.

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
}

interface Neighbor {
  id: number;
  lastHeard: number;
  nick?: string;
  role?: 'phone' | 'beacon';
}

interface MeshEvents {
  /** Hand a finished packet to the radio. */
  transmit(bytes: Uint8Array, reason: 'origin' | 'relay' | 'carry' | 'ack' | 'retry'): void;
  /** A packet for this node (or everyone) arrived for the first time. */
  deliver(p: Packet): void;
  /** A direct message was acknowledged, or gave up after maxAttempts. */
  delivery?(msgId: number, ok: boolean): void;
  /** True while another node is on air; due relays wait so they can overhear it first. */
  channelBusy?(): boolean;
}

interface PendingRelay {
  key: string;
  msgId: number;
  due: number;
  heard: number;
  bytes: Uint8Array;
}

interface PendingAck {
  packet: Packet;
  due: number;
}

const storeKey = (p: Pick<Packet, 'src' | 'msgId'>) => `${p.src}:${p.msgId}`;
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

  constructor(
    readonly id: number,
    private readonly clock: MeshClock,
    private readonly events: MeshEvents,
  ) {}

  /** Sends a packet this node authored. src/hops/attempt are filled in here. */
  originate(p: Omit<Packet, 'src' | 'hops' | 'attempt'>): Packet {
    const packet: Packet = { ...p, src: this.id, hops: 0, attempt: 0 };
    this.seen.set(relayKey(packet), this.clock.now());
    this.delivered.add(storeKey(packet));
    if (this.isStorable(packet)) this.remember(packet);
    if (packet.ackRequested && packet.dst !== BROADCAST) {
      this.acks.set(packet.msgId, { packet, due: this.clock.now() + this.ackTimeout(packet) });
    } else if (packet.dst === BROADCAST && packet.ttl > 1 && this.isStorable(packet)) {
      this.echoes.set(packet.msgId, { packet, due: this.clock.now() + this.echoTimeout() });
    }
    this.events.transmit(encodePacket(packet), 'origin');
    return packet;
  }

  /** Feeds bytes decoded off the air. Returns the parsed packet, or null for junk. */
  receive(bytes: Uint8Array): Packet | null {
    const p = decodePacket(bytes);
    if (!p) return p;
    if (p.src === this.id) {
      // Someone repeated our broadcast: it made it out.
      this.echoes.delete(p.msgId);
      return p;
    }
    const now = this.clock.now();
    this.stats.heard++;
    if (p.hops === 0) this.touchNeighbor(p.src, now);

    const rk = relayKey(p);
    if (this.seen.has(rk)) {
      for (const r of this.relays) if (r.key === rk) r.heard++;
      // A re-sent direct message we already have still deserves a fresh ACK.
      if (p.dst === this.id && p.ackRequested) this.sendAck(p);
      return p;
    }
    this.seen.set(rk, now);
    this.pruneSeen(now);

    if (p.type === PacketType.Ack) this.onAck(p);
    if (p.type === PacketType.Hello && p.hops === 0) this.onHello(p);
    const sk = storeKey(p);
    const forMe = p.dst === BROADCAST || p.dst === this.id;
    if (forMe && p.type !== PacketType.Ack && p.type !== PacketType.Hello && !this.delivered.has(sk)) {
      this.delivered.add(sk);
      this.stats.delivered++;
      this.events.deliver(p);
    }
    if (p.dst === this.id && p.ackRequested) this.sendAck(p);
    if (this.isStorable(p)) this.remember(p);
    if (this.config.relay && p.dst !== this.id && p.hops + 1 < p.ttl) this.scheduleRelay(p, rk);
    return p;
  }

  /** Announces this node with a summary of the newest packets it holds. */
  hello(nick: string, role: 'phone' | 'beacon') {
    const msgId = (this.clock.random() * 2 ** 32) >>> 0;
    const ids = [...this.store.values()]
      .sort((a, b) => b.firstHeard - a.firstHeard)
      .slice(0, MAX_BLOOM_IDS)
      .map((s) => decodePacket(s.bytes)!.msgId);
    const have = Bloom.of(ids, msgId);
    return this.originate({
      type: PacketType.Hello,
      encrypted: false,
      ackRequested: false,
      msgId,
      dst: BROADCAST,
      ttl: 1,
      channel: 0,
      body: encodeBody({ kind: 'hello', role, nick, hashes: have.hashes, bits: have.bits }),
    });
  }

  private onAck(p: Packet) {
    const body = decodeBody(PacketType.Ack, p.body);
    if (body?.kind !== 'ack') return;
    // The message reached its destination: anyone still holding a relay of it can stand down.
    this.relays = this.relays.filter((r) => r.msgId !== body.msgId);
    if (p.dst === this.id && this.acks.delete(body.msgId)) this.events.delivery?.(body.msgId, true);
  }

  /** A neighbour said hello: push back up to three stored packets its summary lacks. */
  private onHello(p: Packet) {
    const body = decodeBody(PacketType.Hello, p.body);
    if (body?.kind !== 'hello') return;
    const src = p.src;
    const now = this.clock.now();
    this.touchNeighbor(src, now, body.nick, body.role);
    const theirs = new Bloom(body.hashes, body.bits, p.msgId);
    for (const id of this.echoes.keys()) if (theirs.has(id)) this.echoes.delete(id);
    const offers = [...this.store.values()]
      .map((s) => ({ s, p: decodePacket(s.bytes)! }))
      .filter(({ s, p }) => p && p.src !== src && !theirs.has(p.msgId) && now - s.lastPushed > this.config.carryCooldownMs)
      .filter(({ p }) => p.dst === BROADCAST || p.dst === src)
      .sort((a, b) => Number(b.p.dst === src) - Number(a.p.dst === src) || b.s.firstHeard - a.s.firstHeard)
      .slice(0, 3);
    for (const { s, p } of offers) {
      s.lastPushed = now;
      this.stats.carried++;
      this.events.transmit(encodePacket({ ...p, hops: 0 }), 'carry');
    }
  }

  /** Re-sends stored packets (used to answer file-chunk requests). */
  resend(src: number, msgId: number): boolean {
    const s = this.store.get(storeKey({ src, msgId }));
    if (!s) return false;
    s.lastPushed = this.clock.now();
    this.events.transmit(encodePacket({ ...decodePacket(s.bytes)!, hops: 0 }), 'carry');
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
      if (r.heard >= this.config.suppressAfter) {
        this.stats.suppressed++;
        continue;
      }
      this.stats.relayed++;
      this.events.transmit(r.bytes, 'relay');
    }
    for (const [id, a] of this.acks) {
      if (a.due > now) continue;
      if (a.packet.attempt + 1 >= this.config.maxAttempts) {
        this.acks.delete(id);
        this.events.delivery?.(id, false);
        continue;
      }
      a.packet = { ...a.packet, attempt: a.packet.attempt + 1 };
      a.due = now + this.ackTimeout(a.packet);
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
    });
  }

  private scheduleRelay(p: Packet, key: string) {
    const [lo, hi] = this.config.backoffMs;
    this.relays.push({
      key,
      msgId: p.msgId,
      due: this.clock.now() + lo + this.clock.random() * (hi - lo),
      heard: 0,
      bytes: encodePacket({ ...p, hops: p.hops + 1 }),
    });
  }

  private isStorable(p: Packet) {
    return p.type !== PacketType.Ack && p.type !== PacketType.Hello && p.type !== PacketType.FileRequest && p.type !== PacketType.Range;
  }

  private remember(p: Packet) {
    const k = storeKey(p);
    if (this.store.has(k)) return;
    this.store.set(k, { bytes: encodePacket({ ...p, hops: 0, attempt: 0 }), firstHeard: this.clock.now(), lastPushed: -Infinity });
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
