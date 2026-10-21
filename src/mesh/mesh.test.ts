import { describe, expect, it } from 'vitest';
import { rng } from '../modem/channel-sim';
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
    { kind: 'hello', role: 'beacon', nick: 'roof', have: [1, 0xffffffff, 7] },
    { kind: 'filereq', fileSrc: 0xabcdef, fileId: 9, missing: [0, 5, 63, 200] },
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
});
