import { describe, expect, it } from 'vitest';
import { Bloom } from './bloom';
import { type Monitor, type Scenario, explore, selfCheck, story } from './explorer';
import { storeKey } from './node';
import { BROADCAST, PacketType, encodePacket } from './packet';
import { type Body, encodeBody, typeOf } from './payloads';

// Flooding terminates: each node puts a given packet on the air a bounded number of times,
// whatever is lost and in whatever order frames and timers come. On sound, where a frame takes
// 1 to 20 s, a packet sent without bound jams the room for everyone.
//
// The bound, per node and packet: as its author, at most maxAttempts frames (the first send,
// then retries or repeats); as a relay, one frame per attempt it hears; as a carrier, one
// frame per HELLO it heard from a neighbour that had not heard the packet when it said hello.
// What this covers, and how to rerun or extend it: .claude/skills/verify-mesh-property/SKILL.md.

const FULL = !!process.env.MESH_VERIFY_FULL;
const HOUR = 3600_000;

const X = 0x1d0a5e01;
const Y = 0x2c4f7702;
const W = 0x3b8e1103;
const M = 0x59c3ab05;
const names = { [X]: 'check-in X', [Y]: 'chat Y', [W]: 'chat W', [M]: 'chat M' };

const checkIn: Body = { kind: 'checkin', ts: 1_700_000_000, nick: 'ana', status: 'help', note: 'stairwell B' };
const chat: Body = { kind: 'text', ts: 1_700_000_000, nick: 'bo', text: 'water at the gym' };

/** A broadcast from node 99, out of earshot, as a neighbour relayed it. */
const far = (msgId: number, body: Body) =>
  encodePacket({ type: typeOf[body.kind], encrypted: false, ackRequested: false, msgId, src: 99, dst: BROADCAST, ttl: 5, hops: 1, attempt: 0, channel: 0, body: encodeBody(body) });

function emptyHelloFrom(src: number) {
  const { hashes, bits } = Bloom.of([], 0x4e110);
  const body = encodeBody({ kind: 'hello', role: 'phone', nick: '', hashes, bits, part: 0, parts: 1 });
  return encodePacket({ type: PacketType.Hello, encrypted: false, ackRequested: false, msgId: 0x4e110, src, dst: BROADCAST, ttl: 1, hops: 0, attempt: 0, channel: 0, body });
}

const own = (msgId: number, body: Body, dst = BROADCAST) => ({ type: typeOf[body.kind], encrypted: false, ackRequested: dst !== BROADCAST, msgId, dst, ttl: 5, channel: 0, body: encodeBody(body) });

const airBudget: Monitor = {
  sent(w, frame, p) {
    const who = w.name(frame.from);
    const k = storeKey(p);
    // What the author of a HELLO had heard when it summarised its store.
    if (p.type === PacketType.Hello) frame.meta = [...w.heard[frame.from]].sort();
    switch (frame.reason) {
      case 'origin':
      case 'ack':
      case 'retry': {
        const n = w.add(`${who} sent ${k}`);
        const cap = w.nodes[frame.from].config.maxAttempts;
        if (n > cap) return { kind: 'author', message: `${who} put ${w.what(p, frame.from)} on air ${n} times as its author; the bound is maxAttempts = ${cap}` };
        return undefined;
      }
      case 'relay': {
        const n = w.add(`${who} relayed ${k} attempt ${p.attempt}`);
        if (n > 1) return { kind: 'relay', message: `${who} relayed attempt ${p.attempt} of ${w.what(p)} ${n} times; the bound is once per attempt` };
        return undefined;
      }
      default: {
        const n = w.add(`${who} carried ${k}`);
        const may = w.count(`${who} may carry ${k}`);
        if (n > may) {
          return {
            kind: 'carry',
            message: `${who} carried ${w.what(p)} ${n} time(s) but heard ${may} HELLO(s) from neighbours that had not heard it; the bound is one carry per such HELLO`,
          };
        }
        return undefined;
      }
    }
  },
  hearing(w, to, frame, p) {
    if (p.type !== PacketType.Hello || !frame.meta) return;
    for (const k of w.nodes[to].store.keys()) if (!frame.meta.includes(k)) w.add(`${w.name(to)} may carry ${k}`);
  },
};

const flood = (name: string, nodes: string, links: string, more: Partial<Scenario>): Scenario => ({
  name,
  nodes,
  links,
  setup: (w) => w.send('A', own(X, checkIn)),
  losses: 2,
  names,
  maxDepth: 400,
  ...more,
});

const meeting: Scenario = {
  name: 'two nodes meet and swap what the other lacks',
  nodes: 'BN',
  links: '',
  // Relays off: in a pair they only send back what the other just sent, and they blow up the state
  // space. The flood scenarios check relays.
  config: { B: { relay: false }, N: { relay: false } },
  setup(w) {
    w.hear('B', far(X, checkIn));
    w.hear('B', far(Y, chat));
    w.hear('N', far(W, chat));
    w.link('BN');
  },
  hellos: { N: 1, B: 1 },
  losses: 1,
  names,
  maxDepth: 400,
};

const holding: Scenario[] = [
  flood('a check-in floods three nodes that all hear each other', 'ABC', 'AB AC BC', {}),
  flood('a check-in floods four nodes in a line', 'ABCD', 'AB BC CD', {}),
  flood('a check-in floods three nodes while the air is busy at one tick', 'ABC', 'AB AC BC', { losses: 1, busy: 1 }),
  {
    name: 'a direct message and its receipt cross a relay',
    nodes: 'ABC',
    links: 'AB BC',
    // Two attempts stand in for three, which takes 164k states even with nothing lost.
    config: { A: { maxAttempts: 2 } },
    setup: (w) => w.send('A', own(M, chat, 3)),
    losses: 1,
    names,
    maxDepth: 400,
  },
  {
    name: 'a direct message to a neighbour, with all three attempts',
    nodes: 'AB',
    links: 'AB',
    setup: (w) => w.send('A', own(M, chat, 2)),
    losses: 1,
    names,
    maxDepth: 400,
  },
  {
    name: 'a check-in from a node that knows a neighbour, whose echoes are all lost',
    nodes: 'AB',
    links: 'AB',
    setup(w) {
      w.hear('A', emptyHelloFrom(2));
      w.send('A', own(X, checkIn));
    },
    losses: 3,
    names,
    maxDepth: 400,
  },
  meeting,
  ...(FULL
    ? [
        flood('a check-in floods four nodes in a ring', 'ABCD', 'AB AC BD CD', {}),
        flood('a check-in floods three nodes with two losses and busy air', 'ABC', 'AB AC BC', { busy: 1 }),
      ]
    : []),
];

describe('flooding terminates: a node puts each packet on the air a bounded number of times', () => {
  for (const s of holding) {
    it(s.name, () => {
      const r = explore(s, airBudget);
      if (r.violations.length) throw new Error(`counterexample:\n${r.violations.map(story).join('\n\n')}`);
      expect(r.cut, 'maxDepth cut the search short').toBe(0);
    }, 60_000);
  }

  it('copies states exactly: random walks agree with plain runs of the same nodes', () => {
    for (const s of holding) for (const seed of [1, 2, 3]) expect(selfCheck(s, airBudget, 80, seed), s.name).toBeUndefined();
  });
});

// A packet that left a node's store but not its dedupe memory (`seen`) is carried back to it:
// receive() drops the copy as already seen. This check found that it then came back at every
// HELLO; now the dropped copy is remembered and later summaries list it, so it comes back once
// (mesh.test.ts, 'a packet a node forgot is carried back to it once'). That one carry still
// exceeds airBudget's bound, so these stay pinned. If one fails, read the new counterexample: the
// same story in other words means update it (vitest -u); no violation means move it into `holding`.
describe('known finding: a node carries back what its neighbour forgot but still remembers hearing', () => {
  it('a store forgets a chat after 12 h that a neighbour heard three hours later', () => {
    const r = explore(
      {
        name: 'expired',
        nodes: 'BN',
        links: '',
        setup(w) {
          w.hear('N', far(Y, chat));
          w.settle();
          w.pass(3 * HOUR);
          w.hear('B', far(Y, chat));
          w.settle();
          w.link('BN');
        },
        hellos: { N: 1 },
        losses: 1,
        jumps: [{ label: 'ten hours pass', ms: 10 * HOUR }],
        names,
        maxDepth: 200,
      },
      airBudget,
    );
    expect(r.violations.map((v) => v.kind)).toEqual(['carry']);
    expect(story(r.violations[0])).toMatchInlineSnapshot(`
      "1. N hears chat Y from afar
      2. the air settles: N airs a relay of chat Y
      3. 3 hours pass
      4. B hears chat Y from afar
      5. the air settles: B airs a relay of chat Y
      6. ten hours pass: the clock reads 13 h 0 min 6.7 s
      7. N.tick() at 13 h 0 min 6.7 s: its store forgets chat Y
      8. N.hello() queues a summary of its store: nothing
      9. N airs its hello: B hears it
      10. the clock moves on to 13 h 0 min 8.1 s
      11. B.tick() at 13 h 0 min 8.1 s: queues a carry of chat Y
      => B carried chat Y 1 time(s) but heard 0 HELLO(s) from neighbours that had not heard it; the bound is one carry per such HELLO"
    `);
  });

  it('a full store drops a chat that a neighbour still holds', () => {
    const r = explore(
      {
        name: 'evicted',
        nodes: 'BN',
        links: '',
        // Two stands in for the 300 packets a busy beacon fills.
        config: { N: { storeLimit: 2 } },
        setup(w) {
          w.hear('B', far(Y, chat));
          w.hear('N', far(Y, chat));
          w.pass(60_000);
          w.hear('B', far(W, chat));
          w.hear('N', far(W, chat));
          w.pass(60_000);
          w.hear('N', far(M, chat));
          w.settle();
          w.link('BN');
        },
        hellos: { N: 1, B: 1 },
        losses: 1,
        names,
        maxDepth: 200,
      },
      airBudget,
    );
    expect(r.violations.map((v) => v.kind)).toEqual(['carry']);
    expect(story(r.violations[0])).toMatchInlineSnapshot(`
      "1. B hears chat Y from afar
      2. N hears chat Y from afar
      3. 1 minute passes
      4. B hears chat W from afar
      5. N hears chat W from afar
      6. 1 minute passes
      7. N hears chat M from afar
      8. the air settles: B airs a relay of chat Y; B airs a relay of chat W; N airs a relay of chat Y; N airs a relay of chat W; N airs a relay of chat M
      9. N.hello() queues a summary of its store: chat W, chat M
      10. N airs its hello: B hears it
      11. the clock moves on to 2 min 4.9 s
      12. B.tick() at 2 min 4.9 s: queues a carry of chat Y
      => B carried chat Y 1 time(s) but heard 0 HELLO(s) from neighbours that had not heard it; the bound is one carry per such HELLO"
    `);
  });
});
