import { createHash } from 'node:crypto';
import { MeshNode, storeKey } from './node';
import { PACKET_LABEL, type Packet, PacketType, decodePacket } from './packet';
import { decodeBody } from './payloads';

// Bounded explicit-state exploration of real MeshNodes, for the mesh's formal checks
// (flooding-bound.test.ts, and .claude/skills/verify-mesh-property). Nothing in the app imports it.
//
// A state is every node's own fields, the frames waiting in each radio, the clock, and what the
// environment may still do. From each state every step is tried: a waiting frame goes on air (each
// neighbour hears it or, while the loss budget lasts, misses it), a node ticks (with the air clear
// or busy), the clock moves to the next timer due anywhere, a node says hello, or one of the
// scenario's long pauses passes. Timers fire only when their node ticks, so any timer may fire
// late, after anything else. States are deduplicated by a fingerprint, breadth first, so the first
// violation found is a shortest one.

type Events = ConstructorParameters<typeof MeshNode>[2];
export type Reason = Parameters<Events['transmit']>[1];
type Config = MeshNode['config'];

/** A frame a node handed to its radio that has not been on air yet. */
export interface Frame {
  from: number;
  bytes: Uint8Array;
  reason: Reason;
  /** A monitor's note on the frame; part of the state. */
  meta?: string[];
}

export interface Violation {
  kind: string;
  message: string;
}

/** A property, watched step by step. Its bookkeeping lives in `w.ledger`, which is part of the state. */
export interface Monitor {
  /** A node handed a frame to its radio. */
  sent?(w: World, frame: Frame, p: Packet): Violation | undefined;
  /** A node is about to hear a frame. */
  hearing?(w: World, to: number, frame: Frame, p: Packet): void;
}

export interface Scenario {
  name: string;
  /** One letter per node; their ids are 1, 2, 3… in this order. */
  nodes: string;
  /** Pairs that hear each other, both ways, such as 'AB BC'. Setup may change them. */
  links: string;
  config?: Record<string, Partial<Config>>;
  /** Runs once before the exploration, in a fixed order and with nothing lost. */
  setup?(w: World): void;
  /** Receptions the air may lose, in all. */
  losses: number;
  /** HELLOs each node may say, at any moment. */
  hellos?: Record<string, number>;
  /** Long pauses the exploration may insert, each at most once. */
  jumps?: Array<{ label: string; ms: number }>;
  /** Ticks that may run while carrier sense hears someone, in all. */
  busy?: number;
  /** Names for packets in counterexamples, by msgId. */
  names?: Record<number, string>;
  /** Steps from the start past which nothing is explored. */
  maxDepth: number;
}

export type Action =
  | { do: 'air'; frame: number; lost: number[] }
  | { do: 'tick'; node: number; busy: boolean }
  | { do: 'wait' }
  | { do: 'jump'; jump: number }
  | { do: 'hello'; node: number };

/** The timers a node keeps to itself, read only to know when the clock may next move on. */
interface Timers {
  relays: Array<{ due: number }>;
  acks: Map<number, { due: number }>;
  echoes: Map<number, { due: number }>;
}

/** Node fields that are not state: the injected ports, and counters nothing reads. */
const PORTS = new Set(['clock', 'events', 'stats']);
const GOLDEN = 0.6180339887498949;
/** Fingerprints of nodes that no step will change again (see World.step). */
const printed = new WeakMap<MeshNode, string>();

export class World {
  t = 0;
  nodes: MeshNode[];
  radio: Frame[] = [];
  /** Per node: every packet (src:msgId) it has heard on air or sent itself. */
  heard: Array<Set<string>>;
  ledger = new Map<string, number>();
  /** What setup did, for the start of a counterexample. */
  log: string[] = [];
  /**
   * Nodes whose tick might do something: set when a node hears, airs or says something, or the
   * clock moves, and cleared by explore() after a tick of it changed nothing. Not part of the state:
   * a tick depends only on the node and the clock, so it stays idle until one of those changes.
   */
  dirty: boolean[];
  private links = new Set<string>();
  private losses: number;
  private hellos: number[];
  private jumps: boolean[];
  private busy: number;
  private draws: number[];
  /** Nodes this world has copied for itself in the current step; the rest it shares and must not change. */
  private owned: boolean[];
  private airBusy = false;
  private found: Violation[] = [];
  /** What nodes handed their radios, or learnt about their messages, since last asked. */
  private news: Array<{ node: number; text: string }> = [];

  /**
   * `copies` false: steps change the nodes in place, as a plain run would (the reference for
   * replays and the self-check). `shared`: the nodes of the world this one forks.
   */
  private constructor(
    readonly scenario: Scenario,
    private readonly monitor: Monitor,
    private readonly copies: boolean,
    shared?: MeshNode[],
  ) {
    const n = scenario.nodes.length;
    this.heard = Array.from({ length: n }, () => new Set());
    this.dirty = Array(n).fill(true);
    this.draws = Array(n).fill(0);
    this.owned = Array(n).fill(!shared);
    this.losses = scenario.losses;
    this.hellos = [...scenario.nodes].map((name) => scenario.hellos?.[name] ?? 0);
    this.jumps = (scenario.jumps ?? []).map(() => true);
    this.busy = scenario.busy ?? 0;
    this.nodes = shared ? [...shared] : [...scenario.nodes].map((_, i) => this.makeNode(i));
  }

  static start(s: Scenario, m: Monitor, copies = true): World {
    const w = new World(s, m, copies);
    w.nodes.forEach((n, i) => Object.assign(n.config, s.config?.[s.nodes[i]]));
    w.link(s.links);
    s.setup?.(w);
    w.radio.sort(byFrame);
    w.owned.fill(!copies);
    return w;
  }

  /** A copy of this state that shares its nodes until a step changes them. */
  fork(): World {
    const w = new World(this.scenario, this.monitor, true, this.nodes);
    w.t = this.t;
    w.radio = [...this.radio];
    w.heard = this.heard.map((h) => new Set(h));
    w.ledger = new Map(this.ledger);
    w.log = this.log;
    w.dirty = [...this.dirty];
    w.links = new Set(this.links);
    w.losses = this.losses;
    w.hellos = [...this.hellos];
    w.jumps = [...this.jumps];
    w.busy = this.busy;
    w.draws = [...this.draws];
    return w;
  }

  /** A fingerprint of everything that decides what can happen next. */
  key(): string {
    const nodes = this.nodes.map((n) => {
      if (!this.copies) return hash(canon(fields(n)));
      let c = printed.get(n);
      if (c === undefined) printed.set(n, (c = hash(canon(fields(n)))));
      return c;
    });
    const rest = canon([
      this.t,
      [...this.links].sort(),
      this.losses,
      this.hellos,
      this.jumps,
      this.busy,
      this.draws,
      this.heard.map((h) => [...h].sort()),
      [...this.ledger].sort(([a], [b]) => (a < b ? -1 : 1)),
      this.radio,
    ]);
    return hash(`${rest}|${nodes.join('|')}`);
  }

  /** The node, copied into this world first if it still shares it. */
  private own(i: number) {
    if (this.owned[i]) return this.nodes[i];
    const n = this.makeNode(i);
    for (const [k, v] of Object.entries(this.nodes[i])) if (!PORTS.has(k)) Object.assign(n, { [k]: copy(v) });
    this.nodes[i] = n;
    this.owned[i] = true;
    return n;
  }

  private makeNode(i: number) {
    const clock = { now: () => this.t, random: () => this.draw(i) };
    return new MeshNode(i + 1, clock, {
      transmit: (bytes, reason) => this.transmitted(i, bytes, reason),
      deliver: () => undefined,
      delivery: (msgId, ok) => this.news.push({ node: i, text: `learns ${this.scenario.names?.[msgId] ?? 'its message'} ${ok ? 'arrived' : 'failed'}` }),
      channelBusy: () => this.airBusy,
    });
  }

  /** A fixed, well-spread sequence per node, so every run of a path draws the same numbers. */
  private draw(i: number) {
    const k = ++this.draws[i];
    return (k * GOLDEN + i * 0.37) % 1;
  }

  private transmitted(from: number, bytes: Uint8Array, reason: Reason) {
    const p = decodePacket(bytes);
    if (!p) throw new Error(`harness: ${this.name(from)} transmitted a frame that does not decode`);
    const frame: Frame = { from, bytes, reason };
    this.heard[from].add(storeKey(p));
    this.radio.push(frame);
    this.news.push({ node: from, text: `queues ${this.frame(frame, p)}` });
    const v = this.monitor.sent?.(this, frame, p);
    if (v) this.found.push(v);
  }

  // ---- for monitors and setup ----------------------------------------------------------------

  name(i: number) {
    return this.scenario.nodes[i];
  }

  index(name: string) {
    const i = this.scenario.nodes.indexOf(name);
    if (i < 0) throw new Error(`harness: no node ${name}`);
    return i;
  }

  /** A packet in words, as node `viewer` (if any) would say it. */
  what(p: Pick<Packet, 'src' | 'msgId' | 'type' | 'body'>, viewer?: number): string {
    const named = this.scenario.names?.[p.msgId];
    if (named) return named;
    const who = viewer !== undefined && p.src === viewer + 1 ? 'its' : `${this.scenario.nodes[p.src - 1] ?? `node ${p.src}`}'s`;
    if (p.type === PacketType.Ack) {
      const b = decodeBody(PacketType.Ack, p.body);
      return `${who} receipt for ${(b?.kind === 'ack' && this.scenario.names?.[b.msgId]) || 'a message'}`;
    }
    return `${who} ${PACKET_LABEL[p.type]}`;
  }

  count(key: string) {
    return this.ledger.get(key) ?? 0;
  }

  add(key: string, n = 1) {
    const v = this.count(key) + n;
    this.ledger.set(key, v);
    return v;
  }

  link(pairs: string) {
    for (const pair of pairs.split(/\s+/).filter(Boolean)) this.links.add([...pair].sort().join(''));
  }

  unlinkAll() {
    this.links.clear();
  }

  /** A node hears a frame from somewhere outside the world (setup only). */
  hear(name: string, bytes: Uint8Array) {
    const i = this.index(name);
    const p = decodePacket(bytes)!;
    this.heard[i].add(storeKey(p));
    this.own(i).receive(bytes);
    this.news = [];
    this.log.push(`${name} hears ${this.what(p)} from afar`);
  }

  /** A node sends a packet of its own (setup only). */
  send(name: string, p: Parameters<MeshNode['originate']>[0]) {
    this.own(this.index(name)).originate(p);
    this.news = [];
    this.log.push(`${name} sends ${this.what({ ...p, src: this.index(name) + 1 })}`);
  }

  pass(ms: number) {
    this.t += ms;
    const d = duration(ms);
    this.log.push(`${d} ${d.startsWith('1 ') ? 'passes' : 'pass'}`);
  }

  /** Runs every timer and airs every frame, in order and with nothing lost, until all is quiet (setup only). */
  settle() {
    const aired: string[] = [];
    for (let round = 0; round < 1000; round++) {
      this.nodes.forEach((_, i) => this.own(i).tick());
      this.news = [];
      const next = this.radio[0];
      if (next) {
        aired.push(`${this.name(next.from)} airs ${this.frame(next, decodePacket(next.bytes)!)}`);
        this.air(next, []);
        continue;
      }
      const due = this.nextDue();
      if (due === undefined) {
        this.news = [];
        this.found = [];
        if (aired.length) this.log.push(`the air settles: ${aired.join('; ')}`);
        return;
      }
      this.t = due;
    }
    throw new Error('harness: setup never went quiet');
  }

  // ---- exploration ---------------------------------------------------------------------------

  actions(): Action[] {
    const out: Action[] = [];
    this.radio.forEach((f, frame) => {
      for (const lost of subsets(this.ears(f.from), this.losses)) out.push({ do: 'air', frame, lost });
    });
    this.nodes.forEach((_, node) => {
      if (this.dirty[node]) out.push({ do: 'tick', node, busy: false });
      if (this.dirty[node] && this.busy > 0) out.push({ do: 'tick', node, busy: true });
      if (this.hellos[node] > 0) out.push({ do: 'hello', node });
    });
    if (this.nextDue() !== undefined) out.push({ do: 'wait' });
    this.jumps.forEach((left, jump) => left && out.push({ do: 'jump', jump }));
    return out;
  }

  /** Takes one step; returns it in words. */
  step(a: Action): string {
    this.found = [];
    this.news = [];
    // Each step copies what it changes, so a node is never changed after its fingerprint is taken.
    this.owned.fill(!this.copies);
    const label = this.act(a);
    // Waiting frames are a set: any of them may go on air next.
    this.radio.sort(byFrame);
    return label;
  }

  private act(a: Action): string {
    switch (a.do) {
      case 'air': {
        const f = this.radio[a.frame];
        return `${this.name(f.from)} airs ${this.frame(f, decodePacket(f.bytes)!)}: ${this.air(f, a.lost)}`;
      }
      case 'tick': {
        const n = this.own(a.node);
        const held = new Map([...n.store].map(([k, s]) => [k, this.what(decodePacket(s.bytes)!, a.node)]));
        const suppressed = n.stats.suppressed;
        if (a.busy) this.busy--;
        this.airBusy = a.busy;
        n.tick();
        this.airBusy = false;
        const did = this.told(a.node);
        const forgot = [...held].filter(([k]) => !n.store.has(k)).map(([, what]) => what);
        if (forgot.length) did.push(`its store forgets ${forgot.join(', ')}`);
        if (n.stats.suppressed > suppressed) did.push(`stands down ${n.stats.suppressed - suppressed} copy, having heard others`);
        return `${this.name(a.node)}.tick() at ${clock(this.t)}${a.busy ? ' with the air busy' : ''}: ${did.join('; ') || 'nothing due'}`;
      }
      case 'wait':
        this.t = this.nextDue()!;
        this.dirty.fill(true);
        return `the clock moves on to ${clock(this.t)}`;
      case 'jump': {
        const j = this.scenario.jumps![a.jump];
        this.jumps[a.jump] = false;
        this.t += j.ms;
        this.dirty.fill(true);
        return `${j.label}: the clock reads ${clock(this.t)}`;
      }
      case 'hello': {
        this.hellos[a.node]--;
        this.dirty[a.node] = true;
        const n = this.own(a.node);
        const held = [...n.store.values()].map((s) => this.what(decodePacket(s.bytes)!, a.node));
        n.hello(this.name(a.node), 'phone');
        this.news = [];
        return `${this.name(a.node)}.hello() queues a summary of its store: ${held.length ? held.join(', ') : 'nothing'}`;
      }
    }
  }

  violations(): Violation[] {
    return this.found;
  }

  /** Puts a frame on air: its sender hears it end, each neighbour hears it unless in `lost`. */
  private air(f: Frame, lost: number[]) {
    this.radio.splice(this.radio.indexOf(f), 1);
    const p = decodePacket(f.bytes)!;
    const k = storeKey(p);
    this.own(f.from).aired(f.bytes);
    this.dirty[f.from] = true;
    const out: string[] = [];
    for (const to of this.ears(f.from)) {
      const name = this.name(to);
      if (lost.includes(to)) {
        this.losses--;
        out.push(`${name} misses it`);
        continue;
      }
      const node = this.own(to);
      this.dirty[to] = true;
      this.monitor.hearing?.(this, to, f, p);
      const before = node.store.has(k);
      const known = this.heard[to].has(k);
      this.heard[to].add(k);
      node.receive(f.bytes);
      const kept =
        p.type === PacketType.Hello || p.type === PacketType.Ack || p.src === to + 1
          ? 'hears it'
          : before
            ? 'already holds it'
            : node.store.has(k)
              ? 'stores it'
              : `does not keep it${known ? ', having heard it before' : ''}`;
      out.push([`${name} ${kept}`, ...this.told(to)].join(' and '));
    }
    return out.join('; ') || 'nobody in earshot';
  }

  private frame(f: Frame, p: Packet) {
    const what = this.what(p, f.from);
    const attempt = p.attempt ? ` (attempt ${p.attempt})` : '';
    switch (f.reason) {
      case 'origin':
      case 'ack':
        return what;
      case 'retry':
        return `${what} again${attempt}`;
      case 'relay':
        return `a relay of ${what}${attempt}`;
      case 'carry':
        return `a carry of ${what}`;
      case 'answer':
        return `an answer with ${what}`;
    }
  }

  /** What node `i` has done since last asked. */
  private told(i: number) {
    const mine = this.news.filter((n) => n.node === i).map((n) => n.text);
    this.news = this.news.filter((n) => n.node !== i);
    return mine;
  }

  private ears(from: number) {
    return this.nodes.map((_, i) => i).filter((i) => i !== from && this.links.has([this.name(from), this.name(i)].sort().join('')));
  }

  /** The earliest relay, retry or repeat due anywhere after now. */
  private nextDue(): number | undefined {
    let next = Infinity;
    for (const n of this.nodes) {
      const x = n as unknown as Timers;
      for (const r of x.relays) if (r.due > this.t) next = Math.min(next, r.due);
      for (const a of [...x.acks.values(), ...x.echoes.values()]) if (a.due > this.t) next = Math.min(next, a.due);
    }
    return next < Infinity ? next : undefined;
  }
}

export interface Result {
  states: number;
  depth: number;
  /** States left unexpanded at maxDepth: above zero, the bound cut the search short. */
  cut: number;
  violations: Array<Violation & { steps: string[] }>;
}

interface Trail {
  up?: Trail;
  action: Action;
  label: string;
}

/**
 * Explores every run of the scenario within its bounds, stopping after the first depth at which the
 * property fails. Reports a shortest counterexample of each kind of violation found there, after
 * replaying it from scratch on nodes that are never copied.
 */
export function explore(s: Scenario, m: Monitor): Result {
  const root = World.start(s, m);
  if (root.violations().length) throw new Error(`harness: setup of '${s.name}' already breaks the property: ${root.violations()[0].message}`);
  const rootKey = root.key();
  const seen = new Set([rootKey]);
  const found = new Map<string, Violation & { trail: Trail }>();
  let frontier: Array<{ w: World; key: string; trail?: Trail }> = [{ w: root, key: rootKey }];
  let depth = 0;
  let cut = 0;
  while (frontier.length) {
    if (depth === s.maxDepth) {
      cut = frontier.length;
      break;
    }
    const next: typeof frontier = [];
    for (const e of frontier) {
      const actions = e.w.actions();
      const idle = new Set<number>();
      const visit = (action: Action) => {
        const w = e.w.fork();
        for (const i of idle) w.dirty[i] = false;
        const t: Trail = { up: e.trail, action, label: w.step(action) };
        for (const v of w.violations()) if (!found.has(v.kind)) found.set(v.kind, { ...v, trail: t });
        const k = w.key();
        if (k === e.key && action.do === 'tick') idle.add(action.node);
        if (seen.has(k)) return;
        seen.add(k);
        next.push({ w, key: k, trail: t });
      };
      // Plain ticks first: a node whose tick changes nothing is idle for every other step from here,
      // and so is its tick on busy air (which can only hold back relays already due).
      for (const a of actions) if (a.do === 'tick' && !a.busy) visit(a);
      for (const a of actions) if (a.do !== 'tick' || (a.busy && !idle.has(a.node))) visit(a);
    }
    frontier = next;
    if (frontier.length) depth++;
    if (found.size) break;
  }
  const violations = [...found.values()].map(({ trail, ...v }) => ({ ...v, steps: [...root.log, ...replay(s, m, trail, v)] }));
  return { states: seen.size, depth, cut, violations };
}

/** Re-runs a counterexample on nodes that are never copied, so a slip in copying cannot invent one. */
function replay(s: Scenario, m: Monitor, trail: Trail, v: Violation): string[] {
  const path: Trail[] = [];
  for (let t: Trail | undefined = trail; t; t = t.up) path.unshift(t);
  const w = World.start(s, m, false);
  const steps = path.map((t) => w.step(t.action));
  if (steps.join('\n') !== path.map((t) => t.label).join('\n') || !w.violations().some((x) => x.kind === v.kind && x.message === v.message)) {
    throw new Error(`harness: the ${v.kind} counterexample does not replay on uncopied nodes; copying a state lost something`);
  }
  return steps;
}

/**
 * Walks `steps` pseudo-random steps twice, once copying state at every step as explore() does and
 * once changing the same nodes in place, and returns the first step where the two disagree.
 */
export function selfCheck(s: Scenario, m: Monitor, steps: number, seed: number): string | undefined {
  let copied = World.start(s, m);
  const plain = World.start(s, m, false);
  let r = seed;
  for (let i = 0; i < steps; i++) {
    const actions = copied.actions();
    if (!actions.length) return undefined;
    r = (r * 1103515245 + 12345) % 2 ** 31;
    const a = actions[r % actions.length];
    copied = copied.fork();
    const label = copied.step(a);
    if (plain.step(a) !== label || copied.key() !== plain.key()) return `step ${i + 1} (${label}) differs between copied and plain runs`;
  }
  return undefined;
}

/** A counterexample as numbered steps. */
export function story(v: Violation & { steps: string[] }) {
  return [...v.steps.map((s, i) => `${i + 1}. ${s}`), `=> ${v.message}`].join('\n');
}

function hash(text: string) {
  return createHash('sha1').update(text).digest('base64');
}

/** A node's state: its own fields but the ports. */
function fields(n: MeshNode) {
  return Object.fromEntries(Object.entries(n).filter(([k]) => !PORTS.has(k)));
}

/** A deep copy of a node's field. Frames and packet bytes are shared: the mesh never changes them in place. */
function copy<T>(v: T): T {
  if (v === null || typeof v !== 'object' || v instanceof Uint8Array) return v;
  if (v instanceof Map) return new Map([...v].map(([k, x]) => [k, copy(x)])) as T;
  if (v instanceof Set) return new Set([...v].map(copy)) as T;
  if (Array.isArray(v)) return v.map(copy) as T;
  if (Object.getPrototypeOf(v) !== Object.prototype) throw new Error(`harness: cannot copy a ${(v as object).constructor.name} held by a MeshNode`);
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x)])) as T;
}

function subsets(xs: number[], max: number): number[][] {
  let out: number[][] = [[]];
  for (const x of xs) out = [...out, ...out.filter((s) => s.length < max).map((s) => [...s, x])];
  return out;
}

function byFrame(a: Frame, b: Frame) {
  return a.from - b.from || (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0) || compareBytes(a.bytes, b.bytes);
}

function compareBytes(a: Uint8Array, b: Uint8Array) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/**
 * A text of plain data that tells states apart. Order counts everywhere: in Maps and Sets it decides
 * iteration, and each kind of object is built by one line of code, so equal states read the same.
 */
function canon(v: unknown): string {
  if (v instanceof Uint8Array) return `#${v.length}:${Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('latin1')}`;
  if (v instanceof Map) return `M[${[...v].map(([k, x]) => `${canon(k)}=${canon(x)}`).join(',')}]`;
  if (v instanceof Set) return `S[${[...v].map(canon).join(',')}]`;
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `${k}:${canon(x)}`).join(',')}}`;
  return typeof v === 'string' ? JSON.stringify(v) : String(v);
}

function clock(ms: number) {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const h = Math.floor(ms / 3600_000);
  const min = Math.floor((ms % 3600_000) / 60_000);
  const s = ((ms % 60_000) / 1000).toFixed(1);
  return h ? `${h} h ${min} min ${s} s` : `${min} min ${s} s`;
}

function duration(ms: number) {
  const [n, unit] = ms % 3600_000 === 0 ? [ms / 3600_000, 'hour'] : ms % 60_000 === 0 ? [ms / 60_000, 'minute'] : [ms / 1000, 'second'];
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}
