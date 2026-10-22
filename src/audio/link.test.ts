import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecodedFrame } from '../modem/receiver';
import { StubWorker } from '../testing';
import { AirLink, type Spectrum } from './link';
import { type AirTransport, CannotListen } from './transport';

const T0 = Date.parse('2026-10-22T09:00:00Z');
const ms = () => Date.now() - T0;
const INIT = { type: 'init', sampleRate: 48000 };
const MUTE = { type: 'mute', on: true };
const UNMUTE = { type: 'mute', on: false };
/** One second of sound at the link's rate. */
const SECOND = new Float32Array(48000);

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * A link to a room whose speaker takes as long as the sound, behind a capture delay of 250 ms (so
 * the mute tail is 400 ms). What the link does and tells is logged as "<ms from start> <what>".
 */
function room(opts: { failStart?: Error } = {}) {
  const log: string[] = [];
  const note = (what: string) => void log.push(`${ms()} ${what}`);
  const workers: StubWorker[] = [];
  const volume: number[] = [];
  let mic: (chunk: Float32Array) => void = () => undefined;
  const transport: AirTransport = {
    kind: 'simulated',
    captureDelayMs: 250,
    async start(onSamples) {
      note(`microphone on, ${workers.length} decoder`);
      if (opts.failStart) throw opts.failStart;
      mic = onSamples;
      return 48000;
    },
    play(wave, fs) {
      note(`play ${(wave.length / fs) * 1000} ms`);
      return new Promise((r) => setTimeout(r, (wave.length / fs) * 1000));
    },
    setVolume: (v) => void volume.push(v),
  };
  const spawn = () => {
    const w = new StubWorker((m) => m.type === 'mute' && note(m.on ? 'mute' : 'unmute'));
    workers.push(w);
    return w as unknown as Worker;
  };
  const link = new AirLink(
    transport,
    {
      frame: (f) => note(`frame ${f.profile}`),
      sync: (profile) => note(`sync ${profile}`),
      lost: (profile, stage) => note(`lost ${profile} ${stage}`),
      ping: (pos, rho) => note(`ping ${pos} ${rho}`),
      changed: () => note('changed'),
      failed: (message) => note(`failed: ${message}`),
    },
    spawn,
  );
  const worker = () => workers.at(-1)!;
  const sent = (w = worker()) => w.posted.map((p) => p.m);
  return { link, log, note, workers, worker, sent, volume, mic: (c: Float32Array) => mic(c) };
}

describe('starting', () => {
  it('starts the decoder before the microphone, sets the volume, then tells the decoder the sample rate', async () => {
    const { link, log, sent, volume, worker, mic } = room();
    await link.start(0.8);
    expect(log).toEqual(['0 microphone on, 1 decoder']);
    expect(link.sampleRate).toBe(48000);
    expect(volume).toEqual([0.8]);
    expect(sent()).toEqual([INIT]);
    // Samples cross to the decoder without a copy.
    const chunk = new Float32Array(128);
    mic(chunk);
    expect(worker().posted[1]).toEqual({ m: { type: 'samples', data: chunk }, transfer: [chunk.buffer] });
  });

  it('a microphone that will not start stops the decoder and passes the error on', async () => {
    const { link, worker, volume } = room({ failStart: new Error('Permission denied.') });
    await expect(link.start(1)).rejects.toThrow('Permission denied.');
    expect(worker().terminated).toBe(true);
    expect(link.sampleRate).toBe(0);
    expect(volume).toEqual([]);
  });
});

describe('explaining a start that failed', () => {
  it.each([
    ['NotAllowedError', /^The microphone is blocked.*site settings beside the address bar.*aA, then Website Settings/],
    ['SecurityError', /^The microphone is blocked/],
    ['NotFoundError', /^No microphone was found/],
    ['OverconstrainedError', /^No microphone was found/],
    ['NotReadableError', /^The microphone is busy/],
    ['AbortError', /^The microphone is busy/],
  ])('%s', (name, advice) => {
    expect(AirLink.explain(new DOMException('Whatever the browser says.', name))).toMatch(advice);
  });

  it('anything else keeps its own words', () => {
    expect(AirLink.explain(new TypeError('Out of cheese.'))).toBe('Out of cheese. Check that this page may use the microphone, then try again.');
    expect(AirLink.explain('gone')).toBe('gone Check that this page may use the microphone, then try again.');
  });

  it('a page that is not https says to open it over https', () => {
    expect(AirLink.explain(new CannotListen('insecure'))).toMatch(/only on a secure page.*https:\/\//);
  });

  it('a browser that cannot listen names the browsers that can', () => {
    expect(AirLink.explain(new CannotListen('unsupported'))).toMatch(/^This browser cannot listen.*Chrome, Edge, Firefox, Samsung Internet or Safari/);
  });

  it('a second page says where the first one is listening', () => {
    expect(AirLink.explain(new CannotListen('elsewhere'))).toBe(
      'Resonance is already listening in another tab or window of this browser. Use that one, or close it, then try again.',
    );
  });
});

describe('playing', () => {
  it('mutes the decoder from the start of a frame until its sound has passed', async () => {
    const { link, log, note } = room();
    await link.start(1);
    const played = link.play(SECOND, 'fast', (seconds) => note(`started: ${seconds} s of ${link.transmitting?.profile}`));
    expect(link.transmitting).toEqual({ profile: 'fast', seconds: 1, started: T0 });
    await vi.advanceTimersByTimeAsync(2000);
    await played;
    expect(link.transmitting).toBeNull();
    expect(log.slice(1)).toEqual(['0 started: 1 s of fast', '0 mute', '0 play 1000 ms', '1000 changed', '1400 unmute']);
  });

  it('a frame that follows straight on keeps the decoder muted in between', async () => {
    const { link, log } = room();
    await link.start(1);
    void link.play(SECOND, 'audible', () => undefined);
    await vi.advanceTimersByTimeAsync(1100);
    void link.play(SECOND, 'audible', () => undefined);
    await vi.advanceTimersByTimeAsync(2000);
    expect(log.slice(1)).toEqual(['0 mute', '0 play 1000 ms', '1000 changed', '1100 mute', '1100 play 1000 ms', '2100 changed', '2500 unmute']);
  });
});

describe('a failing decoder', () => {
  it('is replaced mid-frame, told the sample rate, and kept muted; it no longer holds the air', async () => {
    const { link, worker, sent, log } = room();
    await link.start(1);
    void link.play(SECOND, 'audible', () => undefined);
    await vi.advanceTimersByTimeAsync(300);
    const first = worker();
    first.say({ type: 'busy', busy: true });
    first.fail();
    expect(first.terminated).toBe(true);
    expect(worker()).not.toBe(first);
    expect(link.busy).toBe(false);
    expect(sent()).toEqual([INIT, MUTE]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent()).toEqual([INIT, MUTE, UNMUTE]);
    expect(log.filter((l) => l.includes('failed'))).toEqual([]);
  });

  it('is muted too while our sound dies away; one that fails in quiet is not', async () => {
    const { link, worker, sent } = room();
    await link.start(1);
    void link.play(SECOND, 'audible', () => undefined);
    await vi.advanceTimersByTimeAsync(1100);
    worker().fail();
    expect(sent()).toEqual([INIT, MUTE]);
    await vi.advanceTimersByTimeAsync(2000);
    worker().fail();
    expect(sent()).toEqual([INIT]);
  });

  it('is given up after four failures within ten minutes; older failures do not count', async () => {
    const { link, worker, workers, sent, log, mic } = room();
    await link.start(1);
    const failAt = async (min: number) => {
      await vi.advanceTimersByTimeAsync(min * 60_000 - ms());
      worker().fail();
    };
    for (const min of [0, 4, 8, 10.5]) await failAt(min);
    // The one at 0 min had left the window: 4, 8 and 10.5 make three.
    expect(workers).toHaveLength(5);
    expect(log.filter((l) => l.includes('failed'))).toEqual([]);
    await failAt(11);
    expect(log.at(-1)).toBe('660000 failed: The sound decoder keeps failing in this browser. Reload the page to listen again.');
    expect(worker().terminated).toBe(true);
    expect(workers).toHaveLength(5);
    // Nothing listens any more: the microphone's samples go nowhere.
    mic(new Float32Array(128));
    expect(sent()).toEqual([INIT]);
  });

  it('is replaced once: a second error from it changes nothing', async () => {
    const { link, workers } = room();
    await link.start(1);
    workers[0].fail();
    workers[0].fail();
    expect(workers).toHaveLength(2);
  });
});

describe('what the decoder hears', () => {
  it('preambles, losses, frames and pings are passed on; the busy flag and the end of a frame clear what is coming in', async () => {
    const { link, worker, log } = room();
    await link.start(1);
    const w = worker();
    w.say({ type: 'sync', profile: 'fast' });
    w.say({ type: 'busy', busy: true });
    expect([link.receiving, link.busy]).toEqual(['fast', true]);
    w.say({ type: 'lost', profile: 'fast', stage: 'body' });
    expect(link.receiving).toBeNull();
    w.say({ type: 'sync', profile: 'audible' });
    w.say({ type: 'frame', frame: { profile: 'audible' } as DecodedFrame });
    expect(link.receiving).toBeNull();
    w.say({ type: 'sync', profile: 'ultrasonic' });
    w.say({ type: 'busy', busy: false });
    expect([link.receiving, link.busy]).toEqual([null, false]);
    w.say({ type: 'ping', pos: 1234, rho: 0.5 });
    expect(log.slice(1)).toEqual(['0 sync fast', '0 changed', '0 lost fast body', '0 sync audible', '0 frame audible', '0 sync ultrasonic', '0 changed', '0 ping 1234 0.5']);
  });

  it('spectra go to each listener until it unsubscribes', async () => {
    const { link, worker } = room();
    await link.start(1);
    const a: Spectrum[] = [];
    const b: Spectrum[] = [];
    const offA = link.onSpectrum((s) => a.push(s));
    link.onSpectrum((s) => b.push(s));
    const bins = new Float32Array(4);
    worker().say({ type: 'spectrum', bins, fs: 48000 });
    offA();
    worker().say({ type: 'spectrum', bins, fs: 48000 });
    expect([a.length, b.length]).toEqual([1, 2]);
    expect(a[0]).toMatchObject({ bins, fs: 48000 });
  });
});
