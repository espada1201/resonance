import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AirTransport } from './audio/transport';
import type { FeedItem } from './journal';
import { SEAL_OVERHEAD } from './mesh/crypto';
import { chunkFile, fileKey, missing } from './mesh/files';
import { BROADCAST, type Packet, PacketType, decodePacket, encodePacket, nodeHex } from './mesh/packet';
import { type Body, decodeBody, encodeBody, nowSec, typeOf } from './mesh/payloads';
import { rng } from './modem/channel-sim';
import { MAX_PAYLOAD } from './modem/framing';
import { airtimeSec } from './modem/modulator';
import { PROFILES } from './modem/profiles';
import type { DecodedFrame } from './modem/receiver';
import { type Draft, Station } from './station';
import { fromB64 } from './persist';
import { MemoryStorage, StubWorker } from './testing';

// Characterization tests: they pin what the station does today, so that its collaborators can
// be moved out of it without changing a packet on air, a byte in storage or a line in the log.

const air: AirTransport = { kind: 'simulated', start: async () => 48000, play: async () => undefined, setVolume() {} };

const BEN = 0x2b2b2b;
const CAL = 0x3c3c3c;
const NEIGHBOUR = 0x123456;
const T0 = Date.parse('2026-10-22T09:00:00Z');

/** A frame the demodulator decoded off the air, carrying `body` from `src`. */
function heard(src: number, msgId: number, body: Body, opts: { hops?: number; airtimeSec?: number } = {}): DecodedFrame {
  const p: Packet = { type: typeOf[body.kind], encrypted: false, ackRequested: false, msgId, src, dst: BROADCAST, ttl: 5, hops: opts.hops ?? 0, attempt: 0, channel: 0, body: encodeBody(body) };
  return frame(encodePacket(p), opts.airtimeSec);
}

function frame(payload: Uint8Array, airtimeSec = 2): DecodedFrame {
  return { payload, profile: 'audible', startSample: 0, airtimeSec, clockRatio: 1, toneSnrDb: 20, corrected: 0 };
}

beforeEach(() => {
  // The constructor listens for the page coming back into view.
  vi.stubGlobal('document', { addEventListener() {}, visibilityState: 'visible' });
  vi.useFakeTimers({ now: T0 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Mutes, unmutes and plays in the order they happen, as "<ms from start> <what>". */
let log: string[] = [];
const ms = () => Date.now() - T0;

/** Every decoder the station made, oldest first. */
let workers: StubWorker[] = [];

/** The global Worker while a station listens: its mutes and unmutes go in the log. */
class LoggedWorker extends StubWorker {
  constructor() {
    super((m) => m.type === 'mute' && void log.push(`${ms()} ${m.on ? 'mute' : 'unmute'}`));
    workers.push(this);
  }
}

const INIT = { type: 'init', sampleRate: 48000 };

/** A station listening to a room whose speaker takes as long as the sound; the mute tail is 150 + 250 ms. */
async function listening(opts: { failStart?: Error; storage?: Storage; rate?: number } = {}) {
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  vi.stubGlobal('Worker', LoggedWorker);
  workers = [];
  log = [];
  const plays: Array<{ at: number; ms: number }> = [];
  const volume: number[] = [];
  let workersAtStart = 0;
  let mic: (chunk: Float32Array) => void = () => undefined;
  const transport: AirTransport = {
    kind: 'simulated',
    captureDelayMs: 250,
    async start(onSamples) {
      workersAtStart = workers.length;
      if (opts.failStart) throw opts.failStart;
      mic = onSamples;
      return opts.rate ?? 48000;
    },
    play(wave, fs) {
      const p = { at: ms(), ms: Math.round((wave.length / fs) * 1000) };
      plays.push(p);
      log.push(`${p.at} play`);
      return new Promise((r) => setTimeout(r, p.ms));
    },
    setVolume: (v) => void volume.push(v),
  };
  const s = new Station(transport, 'phone', opts.storage ?? null);
  await s.start();
  const worker = () => workers.at(-1)!;
  const sent = (w = worker()) => w.posted.map((p) => p.m);
  return { s, plays, volume, worker, sent, mic: (c: Float32Array) => mic(c), workersAtStart: () => workersAtStart };
}

/** Ticks of the station's 200 ms interval fall on whole multiples of 200 ms from start. */
const nextTick = (t: number) => Math.ceil(t / 200) * 200;

/** Every packet the station queues, as it leaves. */
function outbox(s: Station) {
  const out: Array<{ at: number; p: Packet; bytes: Uint8Array }> = [];
  const enqueue = s.radio.enqueue.bind(s.radio);
  vi.spyOn(s.radio, 'enqueue').mockImplementation((bytes, urgent) => {
    out.push({ at: ms(), p: decodePacket(bytes)!, bytes });
    enqueue(bytes, urgent);
  });
  return out;
}

describe('saved files', () => {
  const theirs = new TextEncoder().encode('Open shelters tonight: St Thomas church hall, 40 beds. '.repeat(6));
  const mine = new TextEncoder().encode('My own note, sent from this phone. '.repeat(8));

  /** A station that heard a neighbour's file whole and sent one of its own, then saved. */
  async function session(storage: Storage) {
    const s = new Station(air, 'phone', storage);
    chunkFile(77, { name: 'shelters.txt', mime: 'text/plain' }, theirs).forEach((c, i) => s.onFrame(heard(NEIGHBOUR, 500 + i, c)));
    const own = await s.sendFile('note.txt', 'text/plain', mine);
    s.save();
    return { theirKey: fileKey(NEIGHBOUR, 77), ownKey: own };
  }

  it('a received file and an own file survive a reload whole', async () => {
    const storage = new MemoryStorage();
    const { theirKey, ownKey } = await session(storage);

    const reloaded = new Station(air, 'phone', storage);
    expect(missing(reloaded.files.get(theirKey)!)).toEqual([]);
    expect(missing(reloaded.files.get(ownKey)!)).toEqual([]);
    expect(reloaded.files.data(theirKey)).toEqual(theirs);
    expect(reloaded.files.data(ownKey)).toEqual(mine);
  });

  it('files an earlier version damaged on reload come back whole', async () => {
    const storage = new MemoryStorage();
    const { theirKey, ownKey } = await session(storage);
    // What that version saved after a reload: chunk 0 (name and size, no data) as missing.
    const key = 'resonance:v1:phone:files';
    const damaged = JSON.parse(storage.getItem(key)!) as Array<{ chunks: Array<string | null> }>;
    for (const f of damaged) f.chunks[0] = null;
    storage.setItem(key, JSON.stringify(damaged));

    const reloaded = new Station(air, 'phone', storage);
    expect(reloaded.files.data(theirKey)).toEqual(theirs);
    expect(reloaded.files.data(ownKey)).toEqual(mine);
  });

  it('a file whose first chunk never arrived is still missing it after a reload', () => {
    const storage = new MemoryStorage();
    const s = new Station(air, 'phone', storage);
    chunkFile(78, { name: 'map.txt', mime: 'text/plain' }, theirs).forEach((c, i) => i > 0 && s.onFrame(heard(NEIGHBOUR, 600 + i, c)));
    s.save();

    const reloaded = new Station(air, 'phone', storage);
    expect(missing(reloaded.files.get(fileKey(NEIGHBOUR, 78))!)).toEqual([0]);
    expect(reloaded.files.data(fileKey(NEIGHBOUR, 78))).toBeNull();
  });
});

describe('file transfer', () => {
  // Five chunks: 0 (name and size) and four of data.
  const chunks = chunkFile(77, { name: 'n.txt', mime: 'text/plain' }, new TextEncoder().encode('y'.repeat(600)));

  it('its tick asks for the missing chunks of a quiet file, unsealed and one relay deep', async () => {
    const { s } = await listening();
    const out = outbox(s);
    await s.setPassphrase('blue lantern 7');
    for (const i of [0, 1, 3]) s.onFrame(heard(NEIGHBOUR, 900 + i, chunks[i], { airtimeSec: 8 }));
    await vi.advanceTimersByTimeAsync(90_000);
    const asks = out.filter((o) => o.p.type === PacketType.FileRequest);
    expect(asks.map((o) => [o.at, o.p.ttl, o.p.encrypted, decodeBody(o.p.type, o.p.body)])).toEqual(
      [44_000, 88_000].map((at) => [at, 2, false, { kind: 'filereq', fileSrc: NEIGHBOUR, fileId: 77, missing: [2, 4] }]),
    );
  });

  it('answers an ask for chunks it holds through the mesh, by how far the ask came', async () => {
    const s = new Station(air, 'phone', null);
    const out = outbox(s);
    chunks.forEach((c, i) => s.onFrame(heard(NEIGHBOUR, 900 + i, c)));
    const answer = vi.spyOn(s.mesh, 'answer');
    s.onFrame(heard(CAL, 951, { kind: 'filereq', fileSrc: NEIGHBOUR, fileId: 77, missing: [1, 2] }, { hops: 2 }));
    expect(answer.mock.calls).toEqual([
      [NEIGHBOUR, 901, 2],
      [NEIGHBOUR, 902, 2],
    ]);

    // Its own files too, by the ids its chunks went out with.
    const key = await s.sendFile('mine.txt', 'text/plain', new TextEncoder().encode('x'.repeat(500)));
    const ids = out.filter((o) => o.p.type === PacketType.FileChunk).map((o) => o.p.msgId);
    answer.mockClear();
    s.onFrame(heard(CAL, 952, { kind: 'filereq', fileSrc: s.id, fileId: s.files.get(key)!.fileId, missing: [1, 2] }, { hops: 1 }));
    expect(answer.mock.calls).toEqual([
      [s.id, ids[1], 1],
      [s.id, ids[2], 1],
    ]);
  });
});

describe('saved state', () => {
  const FIXTURE = new URL('./station.fixture.json', import.meta.url);
  const theirs = new TextEncoder().encode('Open shelters tonight: St Thomas church hall, 40 beds. '.repeat(6));
  const mine = new TextEncoder().encode('My own note, sent from this phone. '.repeat(8));

  /** Every random id (node, message, file) comes from one seeded sequence. */
  function seedRandomIds(seed: number) {
    const r = rng(seed);
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(a: T): T => {
      if (a) new Uint8Array(a.buffer, a.byteOffset, a.byteLength).forEach((_, i, b) => (b[i] = Math.floor(r() * 256)));
      return a;
    });
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  }

  /** An afternoon's use, ending in a save: every kind of thing the station keeps. */
  async function afternoon(storage: Storage) {
    seedRandomIds(7);
    const at = (min: number) => vi.setSystemTime(T0 + min * 60_000);
    const s = new Station(air, 'phone', storage);
    s.update({ nick: 'Ana', profile: 'fast', volume: 0.8 });
    at(1);
    s.onFrame(heard(BEN, 101, { kind: 'text', ts: nowSec(), nick: 'Ben', text: 'Water at the north stairwell' }));
    at(2);
    const geo = { lat: 51.4979, lon: -0.1246, accuracyM: 8 };
    s.onFrame(heard(CAL, 102, { kind: 'checkin', ts: nowSec() - 300, nick: 'Cal', status: 'help', geo, note: 'Twisted ankle' }, { hops: 1 }));
    at(3);
    s.onFrame(heard(BEN, 103, { kind: 'contact', ts: nowSec(), name: 'Dr Okafor', phone: '+44 20 7946 0000', note: 'Medic, east gate' }));
    at(4);
    // Direct, and still waiting for its receipt when the app closes.
    await s.say({ kind: 'text', text: 'Are you hurt?' }, CAL);
    at(5);
    await s.say({ kind: 'checkin', status: 'safe', geo: { lat: 51.5007, lon: -0.1246, accuracyM: 12 }, note: 'At the library' });
    at(6);
    chunkFile(77, { name: 'shelters.txt', mime: 'text/plain' }, theirs).forEach((c, i) => s.onFrame(heard(BEN, 500 + i, c)));
    at(7);
    await s.sendFile('note.txt', 'text/plain', mine);
    at(8);
    // Sealed for a circle this station is not in.
    const locked = { type: PacketType.Text, encrypted: true, ackRequested: false, msgId: 104, src: CAL, dst: BROADCAST, ttl: 5, hops: 0, attempt: 0, channel: 9 };
    s.onFrame(frame(encodePacket({ ...locked, body: Uint8Array.from({ length: 30 }, (_, i) => i * 7) })));
    at(9);
    await s.setPassphrase('blue lantern 7');
    at(10);
    await s.say({ kind: 'text', text: 'Meet at six' });
    s.save();
    return s;
  }

  /** The six keys as that afternoon left them, recorded from the station before it was split up and before it kept a safety log. */
  const fixture = () => JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, string>;
  const FEED = 'resonance:v1:phone:feed';
  const SETTINGS = 'resonance:v1:phone:settings';
  const SAFETY = 'resonance:v1:phone:safety';
  const STORE = 'resonance:v1:phone:store';
  const IDENTITY = 'resonance:v1:phone:identity';
  /** Each part as a later version reads it back. */
  const parsed = (parts: Record<string, string>) => Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, JSON.parse(v)]));
  /** That afternoon's safety log: the two check-ins in its feed, as they arrived. */
  function safetyLog() {
    const feed = JSON.parse(fixture()[FEED]) as FeedItem[];
    const checkins = feed.filter((i) => i.body?.kind === 'checkin').reverse();
    expect(checkins.map((i) => i.src)).toEqual([CAL, JSON.parse(fixture()[IDENTITY]).id]);
    return { checkins: checkins.map(({ src, msgId, at, hops, encrypted, body }) => ({ src, msgId, at, hops, encrypted, body })), replies: [], notices: [] };
  }

  it('saves at once when the page is hidden, which may freeze or close it before a pending save runs', () => {
    let onVisibility = () => {};
    const doc = { visibilityState: 'visible', addEventListener: (type: string, fn: () => void) => void (type === 'visibilitychange' && (onVisibility = fn)) };
    vi.stubGlobal('document', doc);
    const storage = new MemoryStorage();
    const s = new Station(air, 'phone', storage);
    s.update({ nick: 'Ana' });
    doc.visibilityState = 'hidden';
    onVisibility();
    expect(storage.getItem(SETTINGS)).toContain('"nick":"Ana"');
  });

  it('what still waited to go on air when the page closed goes when it opens again', async () => {
    const storage = new MemoryStorage();
    const first = new Station(air, 'phone', storage);
    first.update({ nick: 'Ana' });
    await first.say({ kind: 'checkin', status: 'help', note: 'Trapped, floor 4' });
    await first.say({ kind: 'text', text: 'Are you hurt?' }, CAL);
    first.save();
    const { s } = await listening({ storage });
    expect(s.journal.feed.map((i) => i.delivery)).toEqual(['sending', undefined]);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    const sent = s.air.filter((e) => e.dir === 'tx').map((e) => e.label);
    expect(sent.filter((l) => l === 'check-in')).toHaveLength(2);
    expect(sent.filter((l) => l === 'message')).toHaveLength(s.mesh.config.maxAttempts);
  });

  it('saves what the fixture records, plus two settings, the safety log, and which of its packets never went on air', async () => {
    const storage = new MemoryStorage();
    await afternoon(storage);
    const old = parsed(fixture());
    const own = (e: { b: string }) => decodePacket(fromB64(e.b))!.src === old[IDENTITY].id;
    const store = old[STORE].map((e: { b: string }) => (own(e) ? { ...e, q: 1 } : e));
    expect(store.filter(own)).toHaveLength(6);
    expect(parsed(storage.dump())).toEqual({ ...old, [SETTINGS]: { ...old[SETTINGS], place: '', outside: '' }, [SAFETY]: safetyLog(), [STORE]: store });
  });

  it('reads a save from before the safety log, whose check-ins seed the roster, and writes it back with only the new parts added', async () => {
    const saved = fixture();
    const storage = MemoryStorage.of(saved);
    const s = new Station(air, 'phone', storage);
    expect(s.settings).toEqual({ nick: 'Ana', profile: 'fast', relay: true, volume: 0.8, passphrase: 'blue lantern 7', answerFind: true, place: '', outside: '' });
    expect(s.journal.feed).toHaveLength(9);
    // Retry timers do not survive a reload: the direct message still waiting says so.
    expect(s.journal.feed.find((i) => i.dst === CAL)).toMatchObject({ mine: true, delivery: 'unknown' });
    expect(s.journal.roster().map((e) => [e.latest.src, e.latest.body.status, e.open])).toEqual([
      [CAL, 'help', true],
      [s.id, 'safe', false],
    ]);
    expect(s.files.data(fileKey(BEN, 77))).toEqual(theirs);
    const own = s.journal.feed.find((i) => i.mine && i.fileKey);
    expect(own && s.files.data(own.fileKey!)).toEqual(mine);
    expect(s.mesh.store.size).toBe(14);

    s.save();
    expect(saved[FEED].split('"delivery":"sending"')).toHaveLength(2);
    expect(storage.dump()).toEqual({
      ...saved,
      [FEED]: saved[FEED].replace('"delivery":"sending"', '"delivery":"unknown"'),
      [SETTINGS]: saved[SETTINGS].replace(/}$/, ',"place":"","outside":""}'),
      [SAFETY]: JSON.stringify(safetyLog()),
    });

    // The circle is joined again from the saved passphrase, and the file's chunks can be handed on.
    await vi.waitFor(() => expect(s.circleChannel).not.toBeNull(), { timeout: 10_000 });
    const answer = vi.spyOn(s.mesh, 'answer');
    s.onFrame(heard(CAL, 990, { kind: 'filereq', fileSrc: BEN, fileId: 77, missing: [1, 2] }));
    expect(answer.mock.calls).toEqual([
      [BEN, 501, 0],
      [BEN, 502, 0],
    ]);
  });

  it('a change that saves nothing writes nothing; a message heard writes only the feed and the store', async () => {
    const storage = new MemoryStorage();
    const { s, worker } = await listening({ storage });
    await vi.advanceTimersByTimeAsync(1000);
    const setItem = vi.spyOn(storage, 'setItem');
    worker().say({ type: 'busy', busy: true });
    worker().say({ type: 'sync', profile: 'audible' });
    worker().say({ type: 'busy', busy: false });
    s.setPosition({ lat: 51.5, lon: -0.12, accuracyM: 10 });
    await vi.advanceTimersByTimeAsync(900);
    expect(setItem).not.toHaveBeenCalled();
    s.onFrame(heard(BEN, 101, { kind: 'text', ts: nowSec(), nick: 'Ben', text: 'Hi' }));
    await vi.advanceTimersByTimeAsync(900);
    expect(setItem.mock.calls.map(([key]) => key)).toEqual(['resonance:v1:phone:feed', 'resonance:v1:phone:store']);
  });
});

describe('settings', () => {
  it('take effect when loaded and when changed; a beacon relays whatever its settings say', () => {
    const s = new Station(air, 'phone', MemoryStorage.of({ 'resonance:v1:phone:settings': '{"relay":false,"answerFind":false}' }));
    expect([s.settings.relay, s.mesh.config.relay, s.ranger.answering]).toEqual([false, false, false]);
    s.update({ relay: true, answerFind: true });
    expect([s.settings.relay, s.mesh.config.relay, s.ranger.answering]).toEqual([true, true, true]);

    const b = new Station(air, 'beacon', MemoryStorage.of({ 'resonance:v1:beacon:settings': '{"relay":false}' }));
    expect([b.settings.relay, b.mesh.config.relay, b.mesh.config.backoffMs]).toEqual([true, true, [400, 2500]]);
    b.update({ relay: false });
    expect([b.settings.relay, b.mesh.config.relay]).toEqual([false, true]);
  });

  it('a new volume goes to the speaker at once', () => {
    const volume: number[] = [];
    const s = new Station({ ...air, setVolume: (v) => void volume.push(v) }, 'phone', null);
    s.update({ nick: 'Ana' });
    s.update({ volume: 0.4 });
    expect(volume).toEqual([0.4]);
  });
});

describe('what people say', () => {
  const CIRCLE = 'blue lantern 7';

  /** A station in the circle, and everything it sends. */
  async function member(nick: string) {
    const m = new Station(air, 'phone', null);
    m.update({ nick });
    await m.setPassphrase(CIRCLE);
    return { m, out: outbox(m) };
  }

  /** The same packet, as if relayed `hops` times on its way here. */
  const relayed = (bytes: Uint8Array, hops: number) => frame(encodePacket({ ...decodePacket(bytes)!, hops }));
  const text = (src: number, msgId: number, t: string) => heard(src, msgId, { kind: 'text', ts: nowSec(), nick: 'Ben', text: t });

  it("stamps the name and the time on what is said; your own check-in's place and family contact become your defaults", async () => {
    const s = new Station(air, 'phone', null);
    s.update({ nick: 'Ana' });
    const out = outbox(s);
    await s.say({ kind: 'checkin', status: 'help', needs: ['injured'], note: 'Twisted ankle', place: 'Floor 4, room 412', outside: 'Mum +44 7700 900123' });
    await s.say({ kind: 'checkin', status: 'safe', note: 'Seen at the gym', about: 'Mr Ito', place: 'Gym' });
    await s.say({ kind: 'contact', name: 'Dr Okafor', phone: '+44 20 7946 0000', note: 'Medic' }, CAL);
    expect(out.map((o) => [o.p.dst, decodeBody(o.p.type, o.p.body)])).toMatchObject([
      [BROADCAST, { kind: 'checkin', ts: nowSec(), nick: 'Ana', status: 'help', needs: ['injured'], place: 'Floor 4, room 412', outside: 'Mum +44 7700 900123' }],
      [BROADCAST, { kind: 'checkin', ts: nowSec(), nick: 'Ana', about: 'Mr Ito', place: 'Gym' }],
      [CAL, { kind: 'contact', ts: nowSec(), name: 'Dr Okafor' }],
    ]);
    // A check-in about someone else leaves them as they were.
    expect([s.settings.place, s.settings.outside]).toEqual(['Floor 4, room 412', 'Mum +44 7700 900123']);
  });

  it('measures the very packet that goes: a draft with 0 bytes left fits, one more byte does not, and a seal costs its overhead', async () => {
    const s = new Station(air, 'phone', null);
    s.update({ nick: 'Ana', profile: 'fast' });
    const out = outbox(s);
    const { left } = s.budget({ kind: 'text', text: '' });
    const full: Draft = { kind: 'text', text: 'x'.repeat(left) };
    expect(s.budget(full)).toEqual({ left: 0, seconds: airtimeSec(PROFILES.fast, MAX_PAYLOAD) });
    await s.say(full);
    expect(out.map((o) => o.bytes.length)).toEqual([MAX_PAYLOAD]);
    await expect(s.say({ kind: 'text', text: 'x'.repeat(left + 1) })).rejects.toThrow('That is too long for one sound packet.');
    await s.setPassphrase(CIRCLE);
    expect(s.budget({ kind: 'text', text: '' }).left).toBe(left - SEAL_OVERHEAD);
  });

  it('after a reload, says nothing until the circle key is made again, then says it sealed', async () => {
    const storage = new MemoryStorage();
    const first = new Station(air, 'phone', storage);
    await first.setPassphrase(CIRCLE);
    first.save();
    const s = new Station(air, 'phone', storage);
    const out = outbox(s);
    await s.say({ kind: 'text', text: 'Meet at the library' });
    expect(out.map((o) => o.p.encrypted)).toEqual([true]);
  });

  it('where the circle key cannot be made again, refuses to say anything in the open', async () => {
    const storage = new MemoryStorage();
    const first = new Station(air, 'phone', storage);
    await first.setPassphrase(CIRCLE);
    first.save();
    vi.spyOn(crypto.subtle, 'importKey').mockRejectedValue(new DOMException('Not on a secure page', 'NotSupportedError'));
    const s = new Station(air, 'phone', storage);
    const out = outbox(s);
    await expect(s.say({ kind: 'text', text: 'Meet at the library' })).rejects.toThrow('Your circle could not be joined in this browser');
    expect(out).toEqual([]);
  });

  it('reckons a 4 KB photo at about 3 minutes in Fast and 14 in Audible, as measured with three devices', () => {
    const s = new Station(air, 'phone', null);
    s.update({ profile: 'fast' });
    expect(s.fileSeconds(4096)).toBeCloseTo(180, -1);
    s.update({ profile: 'audible' });
    expect(s.fileSeconds(4096)).toBeCloseTo(830, -1);
  });

  it('answers a check-in sealed exactly when it was, and will not answer a sealed one from outside the circle', async () => {
    const ben = await member('Ben');
    await ben.m.say({ kind: 'checkin', status: 'help', note: 'Twisted ankle' });
    const { m: s, out } = await member('Ana');
    s.onFrame(frame(ben.out[0].bytes));
    s.onFrame(heard(CAL, 2, { kind: 'checkin', ts: nowSec(), nick: 'Cal', status: 'medical', note: 'Asthma' }));
    await vi.waitFor(() => expect(s.journal.roster()).toHaveLength(2));
    const checkIn = (src: number) => s.journal.roster().find((e) => e.latest.src === src)!.latest;

    await s.reply(checkIn(ben.m.id), 'coming');
    await s.reply(checkIn(CAL), 'coming');
    expect(out.map((o) => [o.p.type, o.p.encrypted])).toEqual([
      [PacketType.Reply, true],
      [PacketType.Reply, false],
    ]);
    await s.setPassphrase('');
    await expect(s.reply(checkIn(ben.m.id), 'resolved')).rejects.toThrow('Join the circle again to answer this.');
    await s.reply(checkIn(CAL), 'resolved');
    expect(out.map((o) => o.p.encrypted)).toEqual([true, false, false]);
    expect(s.journal.roster().map((e) => [e.latest.src, e.coming, e.resolved])).toEqual([
      [ben.m.id, true, false],
      [CAL, true, true],
    ]);
  });

  it('sends a direct message again as a fresh packet, sealed as the first was, in place of the old one', async () => {
    const { m: s, out } = await member('Ana');
    await s.say({ kind: 'text', text: 'Are you hurt?' }, CAL);
    const [first] = s.journal.feed;
    vi.setSystemTime(T0 + 60_000);
    await s.resend(first);
    expect(s.journal.feed).toHaveLength(1);
    expect(s.journal.feed[0]).toMatchObject({ dst: CAL, encrypted: true, delivery: 'sending', body: { text: 'Are you hurt?', ts: nowSec() } });
    expect(s.journal.feed[0].msgId).not.toBe(first.msgId);
    expect(out.map((o) => [o.p.dst, o.p.encrypted])).toEqual([
      [CAL, true],
      [CAL, true],
    ]);
    // Out of the circle it will not send the circle's message in the open, and keeps it.
    await s.setPassphrase('');
    await expect(s.resend(s.journal.feed[0])).rejects.toThrow('Join the circle again to send this.');
    expect(out).toHaveLength(2);
    expect(s.journal.feed).toHaveLength(1);
  });

  /** Ben asks for help and Cal answers, both sealed for the circle; then a message in the open. */
  async function sealedNews() {
    const ben = await member('Ben');
    const cal = await member('Cal');
    await ben.m.say({ kind: 'checkin', status: 'help', note: 'Twisted ankle' });
    await cal.m.reply(ben.m.journal.roster()[0].latest, 'coming');
    return { ben, cal, frames: [relayed(ben.out[0].bytes, 2), frame(cal.out[0].bytes), text(BEN, 7, 'Water at the north stairwell')] };
  }

  /** A station outside the circle that heard it all. */
  function outsider(frames: DecodedFrame[]) {
    const s = new Station(air, 'phone', null);
    frames.forEach((f) => s.onFrame(f));
    expect(s.journal.feed.map((i) => i.locked)).toEqual([false, true, true]);
    return s;
  }

  it('opens sealed news heard before joining where it lies: the check-in in the roster as it arrived, the reply under it', async () => {
    const { ben, frames } = await sealedNews();
    const s = outsider(frames);
    vi.setSystemTime(T0 + 60_000);
    await s.setPassphrase(CIRCLE);
    expect(s.journal.feed.map((i) => [i.src, i.locked, i.body?.kind])).toEqual([
      [BEN, false, 'text'],
      [ben.m.id, false, 'checkin'],
    ]);
    const [entry] = s.journal.roster();
    expect(entry.latest).toMatchObject({ src: ben.m.id, at: T0, hops: 2, encrypted: true });
    expect([entry.open, entry.coming]).toEqual([true, true]);
  });

  it('opens sealed safety news the feed has let go of into the safety list, and leaves the feed as it was', async () => {
    const { ben, frames } = await sealedNews();
    await ben.m.say({ kind: 'notice', topic: 'water', hours: 24, place: 'Gym', text: 'Drinking water' });
    const storage = new MemoryStorage();
    const busy = new Station(air, 'phone', storage);
    [...frames, frame(ben.out[1].bytes)].forEach((f) => busy.onFrame(f));
    // A busy shelter: the feed keeps its newest 400 items, and saves 200 of them for a reload.
    for (let i = 0; i < 400; i++) busy.onFrame(text(BEN, 100 + i, `chat ${i}`));
    busy.save();
    const reloaded = new Station(air, 'phone', storage);
    vi.setSystemTime(T0 + 60_000);
    for (const s of [busy, reloaded]) {
      expect(s.journal.feed.some((i) => i.locked)).toBe(false);
      const feed = s.journal.feed.map((i) => i.id);
      await s.setPassphrase(CIRCLE);
      const [entry] = s.journal.roster();
      expect(entry?.latest).toMatchObject({ src: ben.m.id, at: T0, encrypted: true, body: { status: 'help' } });
      expect([entry.open, entry.coming]).toEqual([true, true]);
      expect(s.journal.notices().map((n) => n.body.text)).toEqual(['Drinking water']);
      expect(s.journal.feed.map((i) => i.id)).toEqual(feed);
    }
  });

  it('a sealed file heard before joining comes whole once joined', async () => {
    const ben = await member('Ben');
    const data = new TextEncoder().encode('Open shelters tonight: St Thomas church hall, 40 beds. '.repeat(6));
    const key = await ben.m.sendFile('shelters.txt', 'text/plain', data);
    const s = new Station(air, 'phone', null);
    ben.out.forEach((o) => s.onFrame(frame(o.bytes)));
    expect(s.journal.feed).toEqual([]);
    await s.setPassphrase(CIRCLE);
    expect(s.journal.feed.map((i) => i.fileKey)).toEqual([key]);
    expect(s.files.data(key)).toEqual(data);
  });

  it('joining while packets arrive ends as joining, then hearing them', async () => {
    const { ben, cal, frames } = await sealedNews();
    await cal.m.say({ kind: 'checkin', status: 'safe', note: 'At the library' });
    // The same packets reach both stations: a message, and a check-in sealed for the circle.
    const later = [text(ben.m.id, 8, 'Meet at six'), frame(cal.out[1].bytes)];
    const alone = outsider(frames);
    const busy = outsider(frames);

    await alone.setPassphrase(CIRCLE);
    later.forEach((f) => alone.onFrame(f));
    // The other hears them while it works through what it holds, as its feed shifts underneath.
    const get = busy.mesh.store.get.bind(busy.mesh.store);
    let arriving = true;
    vi.spyOn(busy.mesh.store, 'get').mockImplementation((key) => {
      if (arriving) {
        arriving = false;
        later.forEach((f) => busy.onFrame(f));
      }
      return get(key);
    });
    await busy.setPassphrase(CIRCLE);
    expect(arriving).toBe(false);

    for (const s of [alone, busy]) await vi.waitFor(() => expect(s.journal.feed).toHaveLength(4));
    expect(busy.journal.feed).toEqual(alone.journal.feed);
    expect(busy.journal.roster()).toEqual(alone.journal.roster());
    expect(alone.journal.roster().map((e) => [e.latest.src, e.latest.body.status, e.coming])).toEqual([
      [ben.m.id, 'help', true],
      [cal.m.id, 'safe', false],
    ]);
  });
});

describe('signal', () => {
  it('rates a neighbour by the frames it airs itself, not by those relayed for it', () => {
    const s = new Station(air, 'phone', null);
    const hi = { kind: 'text', ts: nowSec(), nick: 'Ben', text: 'Hi' } as const;
    s.onFrame(heard(BEN, 1, hi, { hops: 1 }));
    expect(s.links.get(BEN)).toBeNull();
    s.onFrame({ ...heard(BEN, 2, hi), toneSnrDb: 15 });
    expect(s.links.get(BEN)).toEqual({ profile: 'audible', strength: 'fair', at: T0 });
  });
});

describe('sound files', () => {
  /** The browser's decoder, for the 16-bit WAVs the station writes; it hands back two equal channels. */
  class WavDecoder {
    async decodeAudioData(data: ArrayBuffer) {
      const ch = Float32Array.from(new Int16Array(data, 44), (x) => x / 32767);
      return { length: ch.length, numberOfChannels: 2, sampleRate: new DataView(data).getUint32(24, true), getChannelData: () => ch };
    }
  }

  it('a packet saved as a sound file plays back into another station', async () => {
    const a = new Station(air, 'phone', null);
    a.update({ profile: 'fast' });
    await a.say({ kind: 'text', text: 'Meet at six' });
    const [sent] = a.journal.feed;
    expect(a.exportWav({ ...sent, msgId: sent.msgId + 1 })).toBeNull();
    const blob = a.exportWav(sent)!;
    expect(blob.type).toBe('audio/wav');
    const data = await blob.arrayBuffer();
    const v = new DataView(data);
    const ascii = (from: number) => new TextDecoder().decode(data.slice(from, from + 4));
    // 16-bit mono at 48 kHz, with a quarter of a second of quiet before the frame and after it.
    expect([ascii(0), ascii(8), ascii(12), ascii(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
    expect([v.getUint16(22, true), v.getUint32(24, true), v.getUint16(34, true), v.getUint32(40, true)]).toEqual([1, 48000, 16, data.byteLength - 44]);
    const pcm = new Int16Array(data, 44);
    expect(pcm.subarray(0, 12000).every((x) => x === 0)).toBe(true);
    expect(pcm.subarray(-12000).every((x) => x === 0)).toBe(true);

    vi.stubGlobal('OfflineAudioContext', WavDecoder);
    const b = new Station(air, 'phone', null);
    // The decoder lets the page take a turn now and then, so this test's clock has to move.
    const imported = b.importRecording(data);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await imported).toBe(1);
    expect(b.journal.feed[0]).toMatchObject({ src: a.id, msgId: sent.msgId, body: { kind: 'text', text: 'Meet at six' } });
    expect(b.air[0]).toMatchObject({ dir: 'rx', profile: 'fast', label: `message from ${nodeHex(a.id)}` });
    // A recording says nothing about how well we hear its sender.
    expect(b.links.get(a.id)).toBeNull();
  });
});

describe('decoder worker and mute', () => {
  it('starts the decoder before the microphone, then tells it the sample rate', async () => {
    const { s, sent, mic, volume, worker, workersAtStart } = await listening({ storage: MemoryStorage.of({ 'resonance:v1:phone:settings': '{"volume":0.8}' }) });
    expect(workersAtStart()).toBe(1);
    expect(s.status).toBe('listening');
    expect(sent()).toEqual([INIT]);
    expect(volume).toEqual([0.8]);
    // Samples cross to the worker without a copy.
    const chunk = new Float32Array(128);
    mic(chunk);
    expect(worker().posted[1]).toEqual({ m: { type: 'samples', data: chunk }, transfer: [chunk.buffer] });
  });

  it('a microphone that will not start leaves an error and no decoder', async () => {
    const { s, worker } = await listening({ failStart: new Error('Permission denied.') });
    expect(s.status).toBe('error');
    expect(s.error).toBe('Permission denied. Check that this page may use the microphone, then try again.');
    expect(worker().terminated).toBe(true);
  });

  it('mutes the decoder from the start of its own frame until its sound has passed', async () => {
    const { s, plays } = await listening();
    await vi.advanceTimersByTimeAsync(20_000);
    // The startup hello: due 3 s after start (random 0.5), and sent by the tick due then too.
    const [hello] = plays;
    expect(hello.at).toBe(3000);
    expect(log).toEqual(['3000 mute', '3000 play', `${3000 + hello.ms + 400} unmute`]);
    // Logged and counted as it starts.
    const tx = s.air.filter((e) => e.dir === 'tx');
    expect(tx).toMatchObject([{ at: T0 + 3000, profile: 'audible', label: 'hello' }]);
    expect(tx[0].airtimeSec).toBeCloseTo(hello.ms / 1000, 3);
    expect(s.totals.txSec).toBeCloseTo(hello.ms / 1000, 3);
  });

  it('unmutes between queued frames, and listens a while before the next', async () => {
    const { s, plays } = await listening();
    await s.say({ kind: 'text', text: 'One' });
    await s.say({ kind: 'text', text: 'Two' });
    await vi.advanceTimersByTimeAsync(30_000);
    const [one, two] = plays;
    const end = one.at + one.ms;
    // The tail (400 ms) and a listen (400 ms), then the queue's gap: 150 + 600 × 0.5 ms.
    expect(two.at).toBe(nextTick(end + 1250));
    expect(log.slice(0, 6)).toEqual([`${one.at} mute`, `${one.at} play`, `${end + 400} unmute`, `${two.at} mute`, `${two.at} play`, `${two.at + two.ms + 400} unmute`]);
  });

  it('a frame that follows straight on keeps the decoder muted in between', async () => {
    const { s, plays } = await listening();
    await vi.advanceTimersByTimeAsync(20_000);
    log = [];
    // Find plays its ping ahead of the queue; a message queued meanwhile goes the moment it ends.
    s.ranger.start(BEN);
    await s.say({ kind: 'text', text: 'On my way' });
    await vi.advanceTimersByTimeAsync(10_000);
    s.ranger.stop();
    const [, ping, text] = plays;
    expect(text.at).toBe(nextTick(ping.at + ping.ms));
    expect(log).toEqual([`${ping.at} mute`, `${ping.at} play`, `${text.at} mute`, `${text.at} play`, `${text.at + text.ms + 400} unmute`]);
  });

  it('Find waits for a frame being received to end, for up to 4 s', async () => {
    const { s, worker, plays } = await listening();
    await vi.advanceTimersByTimeAsync(20_000);
    worker().say({ type: 'busy', busy: true });
    s.ranger.start(BEN);
    await vi.advanceTimersByTimeAsync(1000);
    expect(plays).toHaveLength(1);
    worker().say({ type: 'busy', busy: false });
    await vi.advanceTimersByTimeAsync(100);
    expect(plays.map((p) => p.at)).toEqual([3000, 21_100]);
    s.ranger.stop();

    await vi.advanceTimersByTimeAsync(20_000);
    worker().say({ type: 'busy', busy: true });
    s.ranger.start(BEN);
    await vi.advanceTimersByTimeAsync(5000);
    expect(plays.map((p) => p.at)).toEqual([3000, 21_100, 45_100]);
    s.ranger.stop();
  });

  it('a decoder the link gives up on stops the station, and only a fresh page starts it again', async () => {
    const { s, worker } = await listening();
    for (let i = 0; i < 4; i++) worker().fail();
    expect(s.status).toBe('error');
    expect(s.error).toBe('The sound decoder keeps failing in this browser. Reload the page to listen again.');
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });
    await s.start();
    expect(reload).toHaveBeenCalledOnce();
    expect(workers).toHaveLength(4);
  });

  it("the decoder's busy flag holds the queue back, and its end clears the frame being received", async () => {
    const { s, worker, plays } = await listening();
    worker().say({ type: 'sync', profile: 'fast' });
    worker().say({ type: 'busy', busy: true });
    expect(s.receiving).toBe('fast');
    expect(s.busy).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(plays).toHaveLength(0);
    worker().say({ type: 'busy', busy: false });
    expect(s.receiving).toBeNull();
    expect(s.busy).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(plays).toHaveLength(1);
  });

  it('preambles, losses and frames update what is being received, the totals and the air log', async () => {
    const { s, worker } = await listening();
    const w = worker();
    w.say({ type: 'sync', profile: 'audible' });
    expect(s.receiving).toBe('audible');
    expect(s.air[0]).toMatchObject({ dir: 'sync', profile: 'audible', label: 'preamble heard' });
    w.say({ type: 'lost', profile: 'audible', stage: 'header' });
    expect(s.receiving).toBeNull();
    expect(s.air[0]).toMatchObject({ dir: 'lost', profile: 'audible', label: 'header unreadable' });
    w.say({ type: 'sync', profile: 'ultrasonic' });
    w.say({ type: 'lost', profile: 'ultrasonic', stage: 'body' });
    expect(s.air[0]).toMatchObject({ dir: 'lost', profile: 'ultrasonic', label: 'too damaged to repair' });
    expect(s.totals.lost).toBe(2);

    w.say({ type: 'sync', profile: 'fast' });
    const f = { ...heard(BEN, 101, { kind: 'text', ts: nowSec(), nick: 'Ben', text: 'Hi' }, { airtimeSec: 1.5 }), profile: 'fast' as const };
    w.say({ type: 'frame', frame: f });
    expect(s.receiving).toBeNull();
    expect(s.totals).toEqual({ rxBits: f.payload.length * 8, rxSec: 1.5, txSec: 0, lost: 2 });
    expect(s.air[0]).toMatchObject({ dir: 'rx', profile: 'fast', label: 'message from 2B2B2B', bytes: f.payload.length, airtimeSec: 1.5 });
    expect(s.journal.feed[0]).toMatchObject({ src: BEN, body: { text: 'Hi' } });
    expect(s.links.get(BEN)).toEqual({ profile: 'fast', strength: 'strong', at: T0 });
  });

  it('hands spectra to the waterfall and pings to Find', async () => {
    const { s, worker } = await listening();
    const spectra: Array<{ bins: Float32Array; fs: number }> = [];
    const off = s.onSpectrum((x) => spectra.push(x));
    const bins = new Float32Array(4);
    worker().say({ type: 'spectrum', bins, fs: 48000 });
    off();
    worker().say({ type: 'spectrum', bins, fs: 48000 });
    expect(spectra).toHaveLength(1);
    expect(spectra[0].bins).toBe(bins);
    expect(spectra[0].fs).toBe(48000);
    const onPing = vi.spyOn(s.ranger, 'onPing');
    worker().say({ type: 'ping', pos: 1234, rho: 0.5 });
    expect(onPing).toHaveBeenCalledWith(1234, 0.5);
  });
});

describe('transmit mode', () => {
  it('sends in Audible while the audio runs too slow for the chosen mode, as a Bluetooth headset makes it', async () => {
    const { s } = await listening({ rate: 16_000 });
    s.update({ profile: 'ultrasonic' });
    expect((['audible', 'fast', 'ultrasonic'] as const).map((id) => s.playable(id))).toEqual([true, true, false]);
    await s.say({ kind: 'text', text: 'Anyone on floor 3?' });
    await vi.advanceTimersByTimeAsync(30_000);
    const tx = s.air.filter((e) => e.dir === 'tx');
    expect(tx.map((e) => e.label)).toContain('message');
    expect(tx.every((e) => e.profile === 'audible')).toBe(true);
    expect(s.budget({ kind: 'text', text: 'Anyone on floor 3?' }).seconds).toBeLessThan(5);
  });
});
