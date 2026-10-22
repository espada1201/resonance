import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FromWorker, ToWorker } from './audio/protocol';
import type { AirTransport } from './audio/transport';
import { chunkFile, fileKey, missing } from './mesh/files';
import { BROADCAST, type Packet, PacketType, decodePacket, encodePacket } from './mesh/packet';
import { type Body, decodeBody, encodeBody, nowSec, typeOf } from './mesh/payloads';
import { rng } from './modem/channel-sim';
import type { DecodedFrame } from './modem/receiver';
import { Station } from './station';

// Characterization tests: they pin what the station does today, so that its collaborators can
// be moved out of it without changing a packet on air, a byte in storage or a line in the log.

class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  static of(items: Record<string, string>) {
    const s = new MemoryStorage();
    for (const [k, v] of Object.entries(items)) s.setItem(k, v);
    return s;
  }
  get length() {
    return this.m.size;
  }
  clear() {
    this.m.clear();
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  dump() {
    return Object.fromEntries(this.m);
  }
}

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

class StubWorker {
  static made: StubWorker[] = [];
  readonly posted: Array<{ m: ToWorker; transfer: Transferable[] }> = [];
  onmessage: ((e: MessageEvent<FromWorker>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminated = false;
  constructor() {
    StubWorker.made.push(this);
  }
  postMessage(m: ToWorker, transfer: Transferable[] = []) {
    this.posted.push({ m, transfer });
    if (m.type === 'mute') log.push(`${ms()} ${m.on ? 'mute' : 'unmute'}`);
  }
  terminate() {
    this.terminated = true;
  }
  say(m: FromWorker) {
    this.onmessage!({ data: m } as MessageEvent<FromWorker>);
  }
  fail() {
    this.onerror!({ preventDefault() {} } as ErrorEvent);
  }
}

const INIT = { type: 'init', sampleRate: 48000 };
const MUTE = { type: 'mute', on: true };
const UNMUTE = { type: 'mute', on: false };

/** A station listening to a room whose speaker takes as long as the sound; the mute tail is 150 + 250 ms. */
async function listening(failStart?: Error) {
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  vi.stubGlobal('Worker', StubWorker);
  StubWorker.made = [];
  log = [];
  const plays: Array<{ at: number; ms: number }> = [];
  const volume: number[] = [];
  let workersAtStart = 0;
  let mic: (chunk: Float32Array) => void = () => undefined;
  const transport: AirTransport = {
    kind: 'simulated',
    captureDelayMs: 250,
    async start(onSamples) {
      workersAtStart = StubWorker.made.length;
      if (failStart) throw failStart;
      mic = onSamples;
      return 48000;
    },
    play(wave, fs) {
      const p = { at: ms(), ms: Math.round((wave.length / fs) * 1000) };
      plays.push(p);
      log.push(`${p.at} play`);
      return new Promise((r) => setTimeout(r, p.ms));
    },
    setVolume: (v) => void volume.push(v),
  };
  const s = new Station(transport, 'phone', null);
  await s.start();
  const worker = () => StubWorker.made.at(-1)!;
  const sent = (w = worker()) => w.posted.map((p) => p.m);
  return { s, plays, volume, worker, sent, mic: (c: Float32Array) => mic(c), workersAtStart: () => workersAtStart };
}

/** Ticks of the station's 200 ms interval fall on whole multiples of 200 ms from start. */
const nextTick = (t: number) => Math.ceil(t / 200) * 200;

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

  /** Every packet the station queues, as it leaves. */
  function outbox(s: Station) {
    const out: Array<{ at: number; p: Packet }> = [];
    const enqueue = s.radio.enqueue.bind(s.radio);
    vi.spyOn(s.radio, 'enqueue').mockImplementation((bytes, urgent) => {
      out.push({ at: ms(), p: decodePacket(bytes)! });
      enqueue(bytes, urgent);
    });
    return out;
  }

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
    await s.sendText('Are you hurt?', CAL);
    at(5);
    await s.sendCheckIn('safe', 'At the library', { lat: 51.5007, lon: -0.1246, accuracyM: 12 });
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
    await s.sendText('Meet at six');
    s.save();
    return s;
  }

  /** The six keys as that afternoon left them, recorded from the station before it was split up. */
  const fixture = () => JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, string>;
  const FEED = 'resonance:v1:phone:feed';

  it('writes what it holds exactly as the fixture records it', async () => {
    const storage = new MemoryStorage();
    await afternoon(storage);
    expect(storage.dump()).toEqual(fixture());
  });

  it('reads the fixture back, and saves it again byte for byte', async () => {
    const saved = fixture();
    const storage = MemoryStorage.of(saved);
    const s = new Station(air, 'phone', storage);
    expect(s.settings).toEqual({ nick: 'Ana', profile: 'fast', relay: true, volume: 0.8, passphrase: 'blue lantern 7', answerFind: true });
    expect(s.feed).toHaveLength(9);
    // Retry timers do not survive a reload: the direct message still waiting says so.
    expect(s.feed.find((i) => i.dst === CAL)).toMatchObject({ mine: true, delivery: 'unknown' });
    expect(s.files.data(fileKey(BEN, 77))).toEqual(theirs);
    const own = s.feed.find((i) => i.mine && 'fileKey' in i);
    expect(own && 'fileKey' in own && s.files.data(own.fileKey!)).toEqual(mine);
    expect(s.mesh.store.size).toBe(14);

    s.save();
    expect(saved[FEED].split('"delivery":"sending"')).toHaveLength(2);
    expect(storage.dump()).toEqual({ ...saved, [FEED]: saved[FEED].replace('"delivery":"sending"', '"delivery":"unknown"') });

    // The circle is joined again from the saved passphrase, and the file's chunks can be handed on.
    await vi.waitFor(() => expect(s.circleChannel).not.toBeNull(), { timeout: 10_000 });
    const answer = vi.spyOn(s.mesh, 'answer');
    s.onFrame(heard(CAL, 990, { kind: 'filereq', fileSrc: BEN, fileId: 77, missing: [1, 2] }));
    expect(answer.mock.calls).toEqual([
      [BEN, 501, 0],
      [BEN, 502, 0],
    ]);
  });
});

describe('decoder worker and mute', () => {
  it('starts the decoder before the microphone, then tells it the sample rate', async () => {
    const { s, sent, mic, volume, worker, workersAtStart } = await listening();
    expect(workersAtStart()).toBe(1);
    expect(s.status).toBe('listening');
    expect(s.sampleRate).toBe(48000);
    expect(sent()).toEqual([INIT]);
    expect(volume).toEqual([1]);
    // Samples cross to the worker without a copy.
    const chunk = new Float32Array(128);
    mic(chunk);
    expect(worker().posted[1]).toEqual({ m: { type: 'samples', data: chunk }, transfer: [chunk.buffer] });
  });

  it('a microphone that will not start leaves an error and no decoder', async () => {
    const { s, worker } = await listening(new Error('Permission denied.'));
    expect(s.status).toBe('error');
    expect(s.error).toBe('Permission denied. Check that this page may use the microphone, then try again.');
    expect(worker().terminated).toBe(true);
  });

  it('mutes the decoder from the start of its own frame until its sound has passed', async () => {
    const { plays } = await listening();
    await vi.advanceTimersByTimeAsync(20_000);
    // The startup hello: due 3 s after start (random 0.5), and sent by the tick due then too.
    const [hello] = plays;
    expect(hello.at).toBe(3000);
    expect(log).toEqual(['3000 mute', '3000 play', `${3000 + hello.ms + 400} unmute`]);
  });

  it('unmutes between queued frames, and listens a while before the next', async () => {
    const { s, plays } = await listening();
    await s.sendText('One');
    await s.sendText('Two');
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
    await s.sendText('On my way');
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

  it('a decoder that fails mid-frame is replaced, told the sample rate, and kept muted', async () => {
    const { s, worker, sent } = await listening();
    await vi.advanceTimersByTimeAsync(3300);
    expect(s.transmitting).not.toBeNull();
    const first = worker();
    first.fail();
    expect(first.terminated).toBe(true);
    expect(worker()).not.toBe(first);
    expect(sent()).toEqual([INIT, MUTE]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sent()).toEqual([INIT, MUTE, UNMUTE]);
    expect(s.status).toBe('listening');
  });

  it('a decoder that fails while its sound dies away is muted too; one that fails in quiet is not', async () => {
    const { worker, sent, plays } = await listening();
    await vi.advanceTimersByTimeAsync(3300);
    const [hello] = plays;
    await vi.advanceTimersByTimeAsync(hello.at + hello.ms + 100 - 3300);
    worker().fail();
    expect(sent()).toEqual([INIT, MUTE]);
    await vi.advanceTimersByTimeAsync(20_000);
    worker().fail();
    expect(sent()).toEqual([INIT]);
  });

  it('gives up after four failures within ten minutes; older failures do not count', async () => {
    const { s, worker } = await listening();
    const failAt = async (min: number) => {
      await vi.advanceTimersByTimeAsync(min * 60_000 - ms());
      worker().fail();
    };
    for (const min of [0, 4, 8, 10.5]) await failAt(min);
    // The one at 0 min had left the window: 4, 8 and 10.5 make three.
    expect(s.status).toBe('listening');
    expect(StubWorker.made).toHaveLength(5);
    await failAt(11);
    expect(s.status).toBe('error');
    expect(s.error).toBe('The sound decoder keeps failing in this browser. Reload the page to listen again.');
    expect(worker().terminated).toBe(true);
    expect(StubWorker.made).toHaveLength(5);
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
    expect(s.feed[0]).toMatchObject({ src: BEN, body: { text: 'Hi' } });
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
