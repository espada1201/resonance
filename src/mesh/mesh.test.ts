import { describe, expect, it } from 'vitest';
import { rng } from '../modem/channel-sim';
import { Bloom, MAX_BLOOM_IDS } from './bloom';
import { deriveCircle, open, seal } from './crypto';
import { MeshNode } from './node';
import { BROADCAST, type Packet, PacketType, decodePacket, encodePacket } from './packet';
import { type Body, decodeBody, encodeBody, typeOf } from './payloads';
import { TxQueue } from './radio';

const AIRTIME = 2000;

/** Discrete-event world: nodes hear each other only along `links`, after one frame of airtime. */
class World {
  t = 0;
  private events: Array<{ at: number; fn: () => void }> = [];
  readonly nodes = new Map<string, MeshNode>();
  readonly inbox = new Map<string, Packet[]>();
  readonly tx: Array<{ from: string; reason: string; packet: Packet }> = [];
  readonly deliveries: Array<[string, number, boolean]> = [];
  private onAir = new Map<string, number>();
  links = new Set<string>();
  drop: (from: string, to: string, p: Packet) => boolean = () => false;
  private readonly r = rng(42);

  add(name: string, id: number) {
    const clock = { now: () => this.t, random: this.r };
    const node = new MeshNode(id, clock, {
      transmit: (bytes, reason) => {
        this.tx.push({ from: name, reason, packet: decodePacket(bytes)! });
        this.onAir.set(name, this.t + AIRTIME);
        this.at(this.t + AIRTIME, () => {
          node.aired(bytes);
          for (const to of this.nodes.keys()) {
            if (to !== name && this.linked(name, to) && !this.drop(name, to, decodePacket(bytes)!)) this.nodes.get(to)!.receive(bytes);
          }
        });
      },
      deliver: (p) => this.inbox.get(name)!.push(p),
      delivery: (msgId, ok) => this.deliveries.push([name, msgId, ok]),
      channelBusy: () => [...this.onAir].some(([from, until]) => until > this.t && this.linked(from, name)),
    });
    this.nodes.set(name, node);
    this.inbox.set(name, []);
    return node;
  }
  link(...pairs: string[]) {
    for (const pair of pairs) this.links.add([...pair].sort().join(''));
  }
  unlinkAll() {
    this.links.clear();
  }
  linked(a: string, b: string) {
    return this.links.has([a, b].sort().join(''));
  }
  at(at: number, fn: () => void) {
    this.events.push({ at, fn });
  }
  run(ms: number) {
    const end = this.t + ms;
    while (this.t < end) {
      this.t += 50;
      const due = this.events.filter((e) => e.at <= this.t);
      this.events = this.events.filter((e) => e.at > this.t);
      due.forEach((e) => e.fn());
      for (const n of this.nodes.values()) n.tick();
    }
  }
}

const text = (s: string, nick = 'ana'): Body => ({ kind: 'text', ts: 1_700_000_000, nick, text: s });

/** A broadcast from node 99, somewhere out of earshot, as a neighbour relayed it. */
const farAway = (msgId: number) =>
  encodePacket({ type: PacketType.Text, encrypted: false, ackRequested: false, msgId, src: 99, dst: BROADCAST, ttl: 5, hops: 1, attempt: 0, channel: 0, body: encodeBody(text(`#${msgId}`)) });

function send(node: MeshNode, body: Body, extra: Partial<Packet> = {}) {
  return node.originate({
    type: typeOf[body.kind],
    encrypted: false,
    ackRequested: false,
    msgId: Math.floor(Math.random() * 2 ** 32),
    dst: BROADCAST,
    ttl: 5,
    channel: 0,
    body: encodeBody(body),
    ...extra,
  });
}

describe('packet + payload codecs', () => {
  it('round-trips every header field', () => {
    const p: Packet = { type: PacketType.CheckIn, encrypted: true, ackRequested: true, msgId: 0xdeadbeef, src: 0x123456, dst: 0xabcdef, ttl: 6, hops: 3, attempt: 2, channel: 77, body: Uint8Array.of(1, 2, 3) };
    const bytes = encodePacket(p);
    expect(bytes.length).toBe(16);
    expect(decodePacket(bytes)).toEqual(p);
  });

  it('rejects junk, wrong versions and exhausted hop counts', () => {
    expect(decodePacket(Uint8Array.of(1, 2, 3))).toBeNull();
    const ok = encodePacket({ type: PacketType.Text, encrypted: false, ackRequested: false, msgId: 1, src: 2, dst: 3, ttl: 2, hops: 1, attempt: 0, channel: 0, body: new Uint8Array() });
    expect(decodePacket(ok)).not.toBeNull();
    expect(decodePacket(Uint8Array.from([0, ...ok.slice(1)]))).toBeNull();
    const spent = ok.slice();
    spent[11] = (2 << 5) | (2 << 2);
    expect(decodePacket(spent)).toBeNull();
  });

  it.each<Body>([
    text('héllo 🌊 world'),
    { kind: 'checkin', ts: 1, nick: 'bo', status: 'medical', geo: { lat: -33.86785, lon: 151.20732, accuracyM: 12 }, note: 'ankle' },
    { kind: 'checkin', ts: 2, nick: 'cy', status: 'safe', note: '' },
    { kind: 'contact', ts: 3, name: 'Dee Rivera', phone: '+1 555 0100', note: 'nurse, 3rd floor' },
    { kind: 'file', fileId: 513, index: 0, total: 4, meta: { name: 'map.png', mime: 'image/png', size: 600 }, data: Uint8Array.of(9, 9) },
    { kind: 'file', fileId: 513, index: 3, total: 4, data: Uint8Array.of(1, 2, 3) },
    { kind: 'ack', msgId: 0xfffffffe, attempt: 1 },
    { kind: 'hello', role: 'beacon', nick: 'roof', hashes: 7, part: 2, parts: 5, bits: Uint8Array.of(1, 0, 255) },
    { kind: 'hello', role: 'phone', nick: '', hashes: 0, part: 0, parts: 1, bits: new Uint8Array() },
    { kind: 'filereq', fileSrc: 0xabcdef, fileId: 9, missing: [0, 5, 63, 200] },
    { kind: 'range', phase: 'request', session: 0, intervalUs: 0 },
    { kind: 'range', phase: 'report', session: 0xffff, intervalUs: 1234567 },
  ])('round-trips $kind bodies', (body) => {
    expect(decodeBody(typeOf[body.kind], encodeBody(body))).toEqual(body);
  });

  it('cuts long nicknames on a character boundary', () => {
    const b = decodeBody(PacketType.Text, encodeBody(text('x', '🌊🌊🌊🌊🌊'))) as Extract<Body, { kind: 'text' }>;
    expect(b.nick).toBe('🌊🌊🌊🌊');
  });
});

describe('circle encryption', () => {
  const base: Packet = { type: PacketType.Text, encrypted: true, ackRequested: false, msgId: 5, src: 6, dst: BROADCAST, ttl: 4, hops: 0, attempt: 0, channel: 0, body: new Uint8Array() };

  it('opens with the right passphrase, survives relaying, and fails closed otherwise', async () => {
    const circle = await deriveCircle('blue heron at dawn');
    const p = { ...base, channel: circle.channel };
    const sealed = { ...p, body: await seal(circle, p, new TextEncoder().encode('meet at the library')) };
    const relayed = decodePacket(encodePacket({ ...sealed, hops: 2, attempt: 1 }))!;
    expect(new TextDecoder().decode((await open(circle, relayed))!)).toBe('meet at the library');

    const other = await deriveCircle('blue heron at dusk');
    expect(await open({ ...other, channel: circle.channel }, relayed)).toBeNull();
    expect(await open(circle, { ...relayed, dst: 123 })).toBeNull();
    const flipped = relayed.body.slice();
    flipped[0] ^= 1;
    expect(await open(circle, { ...relayed, body: flipped })).toBeNull();
  });
});

describe('mesh flooding', () => {
  it('carries a broadcast down a 4-node line, delivering exactly once each', () => {
    const w = new World();
    const [a] = ['A', 'B', 'C', 'D'].map((n, i) => w.add(n, i + 1));
    w.link('AB', 'BC', 'CD');
    send(a, text('hi'));
    w.run(30_000);
    for (const n of ['B', 'C', 'D']) expect(w.inbox.get(n)!.map((p) => p.msgId)).toHaveLength(1);
    expect(w.inbox.get('D')![0].hops).toBe(2);
  });

  it('repeats a broadcast once when no neighbour echoes it, and not when one does', () => {
    const alone = new World();
    const a = alone.add('A', 1);
    const p = send(a, text('anyone out there?'));
    alone.run(120_000);
    expect(alone.tx.filter((t) => t.packet.msgId === p.msgId).map((t) => t.reason)).toEqual(['origin', 'retry']);

    const pair = new World();
    const [b] = ['B', 'C'].map((n, i) => pair.add(n, i + 1));
    pair.link('BC');
    const q = send(b, text('hello C'));
    pair.run(120_000);
    expect(pair.tx.filter((t) => t.from === 'B' && t.packet.msgId === q.msgId)).toHaveLength(1);
  });

  it('starts retry timers when a frame has finished on air, not when it was queued', () => {
    // A frame can wait in the transmit queue behind a whole file. Retrying it before anyone could
    // have heard it only doubles the traffic.
    let t = 0;
    const sent: Array<{ at: number; p: Packet }> = [];
    const n = new MeshNode(1, { now: () => t, random: () => 0.5 }, { transmit: (b) => void sent.push({ at: t, p: decodePacket(b)! }), deliver: () => undefined });
    const echo = send(n, text('queued broadcast'));
    const direct = send(n, text('queued direct'), { dst: 9, ackRequested: true });
    for (; t < 60_000; t += 500) n.tick();
    expect(sent.map((s) => s.p.attempt)).toEqual([0, 0]);
    for (const s of sent.slice()) n.aired(encodePacket(s.p));
    for (; t < 160_000; t += 500) n.tick();
    const retries = sent.filter((s) => s.p.attempt === 1);
    expect(retries.map((s) => s.p.msgId).sort()).toEqual([echo.msgId, direct.msgId].sort());
    // Echo timeout 20-28 s and ACK timeout 45-50 s, both counted from 60 s.
    expect(retries.find((s) => s.p.msgId === echo.msgId)!.at).toBeGreaterThanOrEqual(80_000);
    expect(retries.find((s) => s.p.msgId === direct.msgId)!.at).toBeGreaterThanOrEqual(105_000);
  });

  it('answers a burst of identical file requests once, and never for a frame still queued', () => {
    // Several neighbours missing the same chunk tend to ask at once. A chunk still waiting in our
    // own transmit queue is not missing, just not sent yet.
    let t = 0;
    const out: Array<{ reason: string; bytes: Uint8Array }> = [];
    const n = new MeshNode(1, { now: () => t, random: () => 0.5 }, { transmit: (bytes, reason) => void out.push({ reason, bytes }), deliver: () => undefined });
    const p = send(n, text('chunk'));
    expect(n.answer(1, p.msgId)).toBe(false);
    n.aired(out[0].bytes);
    expect(n.answer(1, p.msgId)).toBe(true);
    t += 3_000;
    expect(n.answer(1, p.msgId)).toBe(false);
    t += 20_000;
    expect(n.answer(1, p.msgId)).toBe(true);
    for (; t < 40_000; t += 500) n.tick();
    const answers = out.filter((o) => o.reason === 'answer').map((o) => decodePacket(o.bytes)!);
    expect(answers.map((a) => a.msgId)).toEqual([p.msgId, p.msgId]);
  });

  it('heals a chunk two hops away: the holder nearest the asker answers, and one answer is enough', () => {
    const w = new World();
    const [a, b] = ['A', 'B', 'C'].map((n, i) => w.add(n, i + 1));
    w.link('AB', 'BC');
    w.drop = (from, to, p) => to === 'C' && p.type === PacketType.Text && p.attempt === 0 && p.hops === 1 && from === 'B' && w.t < 30_000;
    const p = send(a, text('chunk for C'));
    w.run(30_000);
    expect(w.inbox.get('C')).toHaveLength(0);
    // C asks. B heard the request directly; A, holding it too, only through B's relay.
    w.t += 20_000;
    expect(a.answer(1, p.msgId, 1)).toBe(true);
    expect(b.answer(1, p.msgId, 0)).toBe(true);
    w.run(30_000);
    expect(w.inbox.get('C')).toHaveLength(1);
    expect(w.tx.filter((t) => t.reason === 'answer').map((t) => t.from)).toEqual(['B']);
  });

  it('an answer crosses a relay that is missing the packet too', () => {
    const w = new World();
    const [a] = ['A', 'B', 'C'].map((n, i) => w.add(n, i + 1));
    w.link('AB', 'BC');
    // Nothing A sends itself gets through; what it sends on request (one hop deep) does.
    w.drop = (from, _to, p) => from === 'A' && p.hops === 0;
    const p = send(a, text('chunk for B and C'));
    w.run(40_000);
    expect(w.inbox.get('B')).toHaveLength(0);
    expect(a.answer(1, p.msgId, 1)).toBe(true);
    w.run(30_000);
    expect(w.inbox.get('B')).toHaveLength(1);
    expect(w.inbox.get('C')).toHaveLength(1);
  });

  it('any copy of a packet stands down a planned answer, whichever attempt we first caught', () => {
    let t = 0;
    const out: string[] = [];
    const n = new MeshNode(2, { now: () => t, random: () => 0.5 }, { transmit: (_b, reason) => void out.push(reason), deliver: () => undefined });
    n.config.relay = false;
    // We missed the author's first send and caught only its one repeat (attempt 1).
    const chunk = { type: PacketType.Text, encrypted: false, ackRequested: false, msgId: 4242, src: 7, dst: BROADCAST, ttl: 5, hops: 0, channel: 0, body: encodeBody(text('chunk')) };
    n.receive(encodePacket({ ...chunk, attempt: 1 }));
    t += 60_000;
    expect(n.answer(7, 4242)).toBe(true);
    // Another holder answers first (its stored copy: attempt 0, one hop deep).
    n.receive(encodePacket({ ...chunk, attempt: 0, hops: 1 }));
    for (let i = 0; i < 100; i++, t += 100) n.tick();
    expect(out).toEqual([]);
  });

  it('never answers or carries a packet that cannot go one more hop', () => {
    let t = 0;
    const out: Uint8Array[] = [];
    const n = new MeshNode(2, { now: () => t, random: () => 0.5 }, { transmit: (b) => void out.push(b), deliver: () => undefined });
    n.receive(encodePacket({ type: PacketType.Text, encrypted: false, ackRequested: false, msgId: 5, src: 7, dst: BROADCAST, ttl: 1, hops: 0, attempt: 0, channel: 0, body: encodeBody(text('local')) }));
    expect(n.answer(7, 5)).toBe(false);
    for (let i = 0; i < 100; i++, t += 100) n.tick();
    expect(out).toEqual([]);
  });

  it('stops at the TTL', () => {
    const w = new World();
    const [a] = ['A', 'B', 'C', 'D'].map((n, i) => w.add(n, i + 1));
    w.link('AB', 'BC', 'CD');
    send(a, text('short'), { ttl: 2 });
    w.run(30_000);
    expect(w.inbox.get('C')).toHaveLength(1);
    expect(w.inbox.get('D')).toHaveLength(0);
  });

  it('suppresses redundant relays in a crowd where everyone hears everyone', () => {
    const w = new World();
    const names = 'ABCDEFGH'.split('');
    names.forEach((n, i) => w.add(n, i + 1));
    for (const x of names) for (const y of names) if (x < y) w.link(x + y);
    send(w.nodes.get('A')!, text('crowd'));
    w.run(30_000);
    const relays = w.tx.filter((t) => t.reason === 'relay').length;
    expect(relays).toBeLessThanOrEqual(3);
    for (const n of names.slice(1)) expect(w.inbox.get(n)).toHaveLength(1);
  });

  it('acknowledges direct messages across a relay', () => {
    const w = new World();
    const [a] = ['A', 'B', 'C'].map((n, i) => w.add(n, i + 1));
    w.link('AB', 'BC');
    const p = send(a, text('for C only'), { dst: 3, ackRequested: true });
    w.run(30_000);
    expect(w.inbox.get('C')).toHaveLength(1);
    expect(w.inbox.get('B')).toHaveLength(0);
    expect(w.deliveries).toEqual([['A', p.msgId, true]]);
  });

  it('sends receipts as receipts, so the radio puts them ahead of queued traffic', () => {
    const sent: string[] = [];
    const n = new MeshNode(3, { now: () => 0, random: () => 0.5 }, { transmit: (b, reason) => void sent.push(`${PacketType[decodePacket(b)!.type]}:${reason}`), deliver: () => undefined });
    n.receive(encodePacket({ type: PacketType.Text, encrypted: false, ackRequested: true, msgId: 9, src: 1, dst: 3, ttl: 5, hops: 0, attempt: 0, channel: 0, body: encodeBody(text('hi')) }));
    expect(sent).toEqual(['Ack:ack']);
  });

  it('acknowledges each attempt once, however many copies of it arrive', () => {
    let acks = 0;
    const n = new MeshNode(3, { now: () => 0, random: () => 0.5 }, { transmit: (b) => void (decodePacket(b)!.type === PacketType.Ack && acks++), deliver: () => undefined });
    const dm = { type: PacketType.Text, encrypted: false, ackRequested: true, msgId: 77, src: 1, dst: 3, ttl: 5, hops: 1, attempt: 0, channel: 0, body: encodeBody(text('hi C')) };
    for (const hops of [1, 2, 1]) n.receive(encodePacket({ ...dm, hops }));
    expect(acks).toBe(1);
    n.receive(encodePacket({ ...dm, attempt: 1 }));
    expect(acks).toBe(2);
  });

  it('does not acknowledge a direct message it cannot read', () => {
    let acks = 0;
    const n = new MeshNode(3, { now: () => 0, random: () => 0.5 }, { transmit: (b) => void (decodePacket(b)!.type === PacketType.Ack && acks++), deliver: () => undefined, readable: (p) => !p.encrypted });
    const dm = { type: PacketType.Text, encrypted: true, ackRequested: true, msgId: 78, src: 1, dst: 3, ttl: 5, hops: 1, attempt: 0, channel: 9, body: Uint8Array.of(1, 2, 3) };
    n.receive(encodePacket(dm));
    expect(acks).toBe(0);
  });

  it('retries a lost direct message with a new attempt number', () => {
    const w = new World();
    const [a] = ['A', 'B', 'C'].map((n, i) => w.add(n, i + 1));
    w.link('AB', 'BC');
    let dropped = 0;
    w.drop = (_f, to, p) => to === 'C' && p.type === PacketType.Text && p.attempt === 0 && ++dropped > 0;
    const p = send(a, text('retry me'), { dst: 3, ackRequested: true });
    w.run(120_000);
    expect(w.tx.some((t) => t.reason === 'retry' && t.packet.attempt === 1)).toBe(true);
    expect(w.inbox.get('C')).toHaveLength(1);
    expect(w.deliveries).toEqual([['A', p.msgId, true]]);
  });

  it('gives up after the attempt budget when nobody answers', () => {
    const w = new World();
    const a = w.add('A', 1);
    const p = send(a, text('anyone?'), { dst: 99, ackRequested: true });
    w.run(400_000);
    expect(w.tx.filter((t) => t.from === 'A' && t.packet.msgId === p.msgId)).toHaveLength(3);
    expect(w.deliveries).toEqual([['A', p.msgId, false]]);
  });

  it('a receipt that arrives after giving up still counts as delivered', () => {
    const w = new World();
    const a = w.add('A', 1);
    const p = send(a, text('anyone?'), { dst: 99, ackRequested: true });
    w.run(400_000);
    const ack = { type: PacketType.Ack, encrypted: false, ackRequested: false, msgId: 5, src: 99, dst: 1, ttl: 5, hops: 2, attempt: 0, channel: 0 };
    a.receive(encodePacket({ ...ack, body: encodeBody({ kind: 'ack', msgId: p.msgId, attempt: 2 }) }));
    expect(w.deliveries).toEqual([
      ['A', p.msgId, false],
      ['A', p.msgId, true],
    ]);
  });

  it('carries a message in a pocket to a node that was out of range (HELLO sync)', () => {
    const w = new World();
    const [a, b, c] = ['A', 'B', 'C'].map((n, i) => w.add(n, i + 1));
    w.link('AB');
    send(a, { kind: 'checkin', ts: 9, nick: 'ana', status: 'safe', note: 'at the gym' });
    w.run(20_000);
    expect(w.inbox.get('B')).toHaveLength(1);
    // B walks to the next building: only B and C can hear each other now.
    w.unlinkAll();
    w.link('BC');
    c.hello('cal', 'phone');
    w.run(20_000);
    expect(w.inbox.get('C')!.map((p) => decodeBody(p.type, p.body)?.kind)).toEqual(['checkin']);
    expect(b.stats.carried).toBe(1);
    expect(b.neighbors.get(3)?.nick).toBe('cal');
    // C heard B carry A's message, not A: A must not show up as someone C can hear.
    expect(c.neighbors.has(1)).toBe(false);
  });
});

describe('HELLO summaries', () => {
  it('a summary never misses an id it holds and rarely claims one it does not', () => {
    const r = rng(7);
    const u32 = () => Math.floor(r() * 2 ** 32);
    let wrong = 0;
    let trials = 0;
    for (let f = 0; f < 200; f++) {
      const ids = Array.from({ length: MAX_BLOOM_IDS }, u32);
      const have = Bloom.of(ids, u32());
      expect(have.bits.length).toBeLessThanOrEqual(58);
      for (const id of ids) expect(have.has(id)).toBe(true);
      for (let i = 0; i < 100; i++, trials++) wrong += Number(have.has(u32()));
    }
    // 9.6 bits per id with 7 hashes: about 1% false positives in theory.
    expect(wrong / trials).toBeLessThan(0.02);
    expect(Bloom.of([], 1).bits.length).toBe(0);
    expect(Bloom.of([], 1).has(0)).toBe(false);
  });

  it('a new salt on every HELLO makes false positives independent', () => {
    // A packet hidden by a false positive in one HELLO must not stay hidden from the next.
    const r = rng(8);
    const u32 = () => Math.floor(r() * 2 ** 32);
    const ids = Array.from({ length: MAX_BLOOM_IDS }, u32);
    const [first, second] = [Bloom.of(ids, u32()), Bloom.of(ids, u32())];
    const fooled = Array.from({ length: 50_000 }, u32).filter((id) => first.has(id));
    expect(fooled.length).toBeGreaterThan(100);
    expect(fooled.filter((id) => second.has(id)).length / fooled.length).toBeLessThan(0.03);
  });

  it('pushes back only what a neighbour lacks, even among its older packets', () => {
    const w = new World();
    const [a, b] = ['A', 'B'].map((n, i) => w.add(n, i + 1));
    for (const n of [a, b]) n.config.relay = false;
    // Both heard 30 broadcasts from far away, a second apart, but B missed two old ones.
    for (let msgId = 1000; msgId < 1030; msgId++) {
      a.receive(farAway(msgId));
      if (msgId !== 1003 && msgId !== 1010) b.receive(farAway(msgId));
      w.t += 1000;
    }
    w.link('AB');
    b.hello('bo', 'phone');
    w.run(20_000);
    const carried = w.tx.filter((t) => t.reason === 'carry').map((t) => t.packet.msgId);
    expect(carried.sort()).toEqual([1003, 1010]);
    expect(b.store.size).toBe(30);
  });

  it("a room answers a newcomer's hello with one copy of each packet it lacks", () => {
    const w = new World();
    const nodes = ['A', 'B', 'C', 'D', 'N'].map((n, i) => w.add(n, i + 1));
    for (const n of nodes) n.config.relay = false;
    for (const msgId of [500, 501, 502]) for (const n of nodes.slice(0, 4)) n.receive(farAway(msgId));
    w.link('AB', 'AC', 'AD', 'AN', 'BC', 'BD', 'BN', 'CD', 'CN', 'DN');
    nodes[4].hello('n', 'phone');
    w.run(30_000);
    expect(w.tx.filter((t) => t.reason === 'carry').map((t) => t.packet.msgId).sort()).toEqual([500, 501, 502]);
    expect(w.inbox.get('N')).toHaveLength(3);
  });

  for (const carrier of ['beacon', 'phone'] as const) {
    it(`a ${carrier} meeting a newcomer passes on its freshest news at once, however big both stores are`, () => {
      // Both hold the same 300 packets; the carrier also heard one more, five minutes before they met.
      const w = new World();
      const [b, p] = ['B', 'P'].map((n, i) => w.add(n, i + 1));
      for (const n of [b, p]) n.config.relay = false;
      for (let msgId = 1000; msgId < 1300; msgId++) {
        b.receive(farAway(msgId));
        p.receive(farAway(msgId));
        w.t += 1000;
      }
      const [holder, lacker] = carrier === 'beacon' ? [b, p] : [p, b];
      holder.receive(farAway(77));
      w.t += 5 * 60_000;
      w.link('BP');
      // Whoever speaks first, the other one has just met them.
      lacker.hello('x', 'phone');
      w.run(20_000);
      expect(lacker.store.has('99:77')).toBe(true);
      expect(w.tx.filter((t) => t.reason === 'carry').length).toBeLessThanOrEqual(3);
    });
  }

  it('two beacons holding the same 200 packets stay quiet for an hour', () => {
    // A summary only fits ~40 ids, so HELLOs take turns covering slices of the store.
    const w = new World();
    const [a, b] = ['A', 'B'].map((n, i) => w.add(n, i + 1));
    for (const n of [a, b]) n.config.relay = false;
    for (let msgId = 1000; msgId < 1200; msgId++) {
      a.receive(farAway(msgId));
      b.receive(farAway(msgId));
      w.t += 1000;
    }
    w.link('AB');
    // Meeting costs at most a few spare frames (each offers its newest news); then silence.
    const carries = () => w.tx.filter((t) => t.reason === 'carry').length;
    a.hello('a', 'beacon');
    b.hello('b', 'beacon');
    w.run(60_000);
    expect(carries()).toBeLessThanOrEqual(6);
    const afterMeeting = carries();
    for (let minute = 1; minute < 60; minute++) {
      a.hello('a', 'beacon');
      b.hello('b', 'beacon');
      w.run(60_000);
    }
    expect(carries()).toBe(afterMeeting);
  });

  it('finds the gaps anywhere in a 200-packet store within a few HELLOs', () => {
    const w = new World();
    const [a, b] = ['A', 'B'].map((n, i) => w.add(n, i + 1));
    for (const n of [a, b]) n.config.relay = false;
    // Neighbours all along (so no newcomer offers), both hearing the same far-away traffic.
    w.link('AB');
    b.hello('b', 'phone');
    w.run(10_000);
    const lost = [1004, 1077, 1150];
    for (let msgId = 1000; msgId < 1200; msgId++) {
      a.receive(farAway(msgId));
      if (!lost.includes(msgId)) b.receive(farAway(msgId));
      w.t += 1000;
    }
    for (let k = 0; k < 6; k++) {
      b.hello('b', 'phone');
      w.run(30_000);
    }
    expect(w.tx.filter((t) => t.reason === 'carry').map((t) => t.packet.msgId).sort()).toEqual(lost);
    expect(b.store.size).toBe(200);
  });

  it('greets a neighbour it has not heard for a while, once', () => {
    let t = 0;
    let greetings = 0;
    const n = new MeshNode(1, { now: () => t, random: () => 0.5 }, { transmit: () => undefined, deliver: () => undefined, heardHello: (newcomer) => void (newcomer && greetings++) });
    const hello = (msgId: number) => encodePacket({ type: PacketType.Hello, encrypted: false, ackRequested: false, msgId, src: 5, dst: BROADCAST, ttl: 1, hops: 0, attempt: 0, channel: 0, body: encodeBody({ kind: 'hello', role: 'beacon', nick: 'hall', hashes: 0, part: 0, parts: 1, bits: new Uint8Array() }) });
    n.receive(hello(1));
    t += 60_000;
    n.receive(hello(2));
    expect(greetings).toBe(1);
    t += 30 * 60_000;
    n.receive(hello(3));
    expect(greetings).toBe(2);
  });
});

describe('transmit queue', () => {
  it('defers while the air is busy, then sends in order', async () => {
    let t = 0;
    let busy = true;
    const sent: number[] = [];
    const q = new TxQueue({ busy: () => busy, send: async (b) => void sent.push(b[0]) }, { now: () => t, random: () => 0.5 });
    q.enqueue(Uint8Array.of(1));
    q.enqueue(Uint8Array.of(2));
    q.enqueue(Uint8Array.of(0), true);
    await q.tick();
    expect(sent).toEqual([]);
    busy = false;
    for (let i = 0; i < 20; i++) {
      t += 500;
      await q.tick();
    }
    expect(sent).toEqual([0, 1, 2]);
    expect(q.deferrals).toBe(1);
  });

  it('reports the frames a full queue drops, so their retry timers still start', () => {
    const done: number[] = [];
    const q = new TxQueue({ busy: () => false, send: async () => undefined, finished: (b) => void done.push(b[0]) }, { now: () => 0, random: () => 0.5 });
    for (let i = 0; i < 66; i++) q.enqueue(Uint8Array.of(i));
    expect(done).toEqual([64, 65]);
    expect(q.length).toBe(64);
  });

  it("never talks over a neighbour's back-to-back frames, however long the stream", async () => {
    // The 25 s patience is for one stuck reading; each gap between a neighbour's frames resets it.
    const r = rng(5);
    let collisions = 0;
    for (let trial = 0; trial < 100; trial++) {
      let t = 0;
      const frames: Array<[number, number]> = [];
      for (let s = 0; s < 150_000; s += 20_300 + 700 + r() * 600) frames.push([s, s + 20_300]);
      const busyAt = (x: number) => frames.some(([a, b]) => x >= a && x < b);
      let startedAt = -1;
      const q = new TxQueue({ busy: () => busyAt(t), send: async () => void (startedAt = t) }, { now: () => t, random: r });
      t = 100 + r() * 200;
      q.enqueue(Uint8Array.of(1));
      for (; startedAt < 0 && t < 200_000; t += 200) await q.tick();
      if (startedAt < 0 || busyAt(startedAt)) collisions++;
    }
    expect(collisions).toBe(0);
  });

  it('waits out the longest frame, then stops deferring, and reports each finished frame', async () => {
    // Carrier sense can be fooled (a fridge, a stuck decoder); staying silent forever is worse.
    // But a real frame lasts up to 20.3 s, and talking into it loses both frames.
    let t = 0;
    let finished = 0;
    const sent: number[] = [];
    const q = new TxQueue({ busy: () => true, send: async (b) => void sent.push(b[0]), finished: () => finished++ }, { now: () => t, random: () => 0.5 });
    q.enqueue(Uint8Array.of(7));
    for (; t < 24_000; t += 500) await q.tick();
    expect(sent).toEqual([]);
    expect(finished).toBe(0);
    for (; t < 26_500; t += 500) await q.tick();
    expect(sent).toEqual([7]);
    expect(finished).toBe(1);
    expect(q.length).toBe(0);
  });
});
