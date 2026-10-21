import { describe, expect, it } from 'vitest';
import { addNoise, mix, resample, reverb, rng } from './channel-sim';
import { HEADER_SYMBOLS, bodySymbols, decodeBody, encodeBody } from './framing';
import { airtimeSec, modulate } from './modulator';
import { PROFILES, type ProfileId, rawBitrate } from './profiles';
import { type DecodedFrame, Receiver } from './receiver';

const ALL = [PROFILES.audible, PROFILES.ultrasonic];

function listen(stream: Float32Array, fs: number, chunk = 2048) {
  const frames: DecodedFrame[] = [];
  const rx = new Receiver(fs, ALL, { frame: (f) => frames.push(f) });
  for (let i = 0; i < stream.length; i += chunk) rx.push(stream.subarray(i, i + chunk));
  return frames;
}

interface Channel {
  snrDb?: number;
  drift?: number;
  rt60?: number;
  drrDb?: number;
  rxRate?: number;
}

/** Sends one random payload through a simulated channel; returns true when it decodes exactly. */
function trial(pid: ProfileId, ch: Channel, seed: number, len = 48) {
  const fs = 48000;
  const r = rng(seed);
  const payload = Uint8Array.from({ length: len }, () => Math.floor(r() * 256));
  let sig = modulate(payload, PROFILES[pid], fs);
  if (ch.rt60) sig = reverb(sig, fs, ch.rt60, ch.drrDb ?? 0, r);
  const ratio = (1 + (ch.drift ?? 0)) * (fs / (ch.rxRate ?? fs));
  if (ratio !== 1) sig = resample(sig, ratio);
  const rxFs = ch.rxRate ?? fs;
  const offset = Math.floor(r() * rxFs);
  let stream: Float32Array = mix(offset + sig.length + rxFs / 2, [[offset, sig]], 0, r);
  if (ch.snrDb !== undefined) stream = addNoise(stream, ch.snrDb, r);
  const frames = listen(stream, rxFs);
  return frames.length === 1 && frames[0].payload.join() === payload.join() ? frames[0] : null;
}

const successRate = (pid: ProfileId, ch: Channel, n: number) =>
  Array.from({ length: n }, (_, i) => trial(pid, ch, 1000 + i)).filter(Boolean).length / n;

describe.each(['audible', 'ultrasonic'] as const)('%s modem over a simulated channel', (pid) => {
  it('round-trips every payload size at 48 kHz and into a 44.1 kHz receiver', () => {
    for (const len of [1, 17, 120, 255]) {
      expect(trial(pid, {}, len, len)).not.toBeNull();
      expect(trial(pid, { rxRate: 44100 }, len, len)).not.toBeNull();
    }
  });

  it.each([20, 0, -12])('decodes 100%% of frames in white noise at %i dB SNR', (snrDb) => {
    expect(successRate(pid, { snrDb }, 6)).toBe(1);
  });

  it.each([-0.005, 0.005])('tolerates %f sample-clock drift and estimates it', (drift) => {
    const f = trial(pid, { drift, snrDb: 10 }, 7, 200);
    expect(f).not.toBeNull();
    expect(f!.clockRatio).toBeCloseTo(1 + drift, 3);
  });

  it('survives a reverberant room (RT60 0.5 s, direct = reverberant energy)', () => {
    expect(successRate(pid, { rt60: 0.5, drrDb: 0, snrDb: 10 }, 4)).toBe(1);
  });

  it('survives reverb + drift + noise + random offset together', () => {
    expect(successRate(pid, { rt60: 0.3, drrDb: 3, drift: 0.004, snrDb: 0 }, 4)).toBe(1);
  });
});

describe('receiver behaviour', () => {
  it('stays silent on two minutes of pure noise', () => {
    const r = rng(11);
    const frames: DecodedFrame[] = [];
    const rx = new Receiver(48000, ALL, { frame: (f) => frames.push(f) });
    for (let s = 0; s < 120; s++) rx.push(new Float32Array(48000).map(() => 0.3 * (r() - 0.5)));
    expect(frames).toHaveLength(0);
  });

  it('decodes an audible and an ultrasonic frame that overlap in time', () => {
    const fs = 48000;
    const a = new TextEncoder().encode('loud and far');
    const b = new TextEncoder().encode('quiet and near');
    const stream = mix(5 * fs, [[1000, modulate(a, PROFILES.audible, fs)], [9000, modulate(b, PROFILES.ultrasonic, fs)]], 0.01, rng(2));
    const got = listen(stream, fs).map((f) => `${f.profile}:${new TextDecoder().decode(f.payload)}`).sort();
    expect(got).toEqual(['audible:loud and far', 'ultrasonic:quiet and near']);
  });

  it('decodes back-to-back frames and handles odd chunk sizes', () => {
    const fs = 44100;
    const msgs = ['one', 'two', 'three'].map((s) => new TextEncoder().encode(s));
    const sigs = msgs.map((m) => modulate(m, PROFILES.audible, fs));
    let off = 300;
    const parts: Array<[number, Float32Array]> = sigs.map((s) => {
      const p: [number, Float32Array] = [off, s];
      off += s.length + 2000;
      return p;
    });
    const stream = mix(off + fs, parts, 0.005, rng(3));
    expect(listen(stream, fs, 333).map((f) => new TextDecoder().decode(f.payload))).toEqual(['one', 'two', 'three']);
  });

  it('repairs a 60 ms dropout in the middle of a frame with Reed-Solomon', () => {
    const fs = 48000;
    const payload = Uint8Array.from({ length: 120 }, (_, i) => (i * 37) & 255);
    const sig = modulate(payload, PROFILES.audible, fs);
    sig.fill(0, Math.round(sig.length * 0.5), Math.round(sig.length * 0.5 + 0.06 * fs));
    const frames = listen(mix(sig.length + fs, [[500, sig]], 0.002, rng(4)), fs);
    expect(frames).toHaveLength(1);
    expect(Array.from(frames[0].payload)).toEqual(Array.from(payload));
    expect(frames[0].corrected).toBeGreaterThan(0);
  });

  it('reports honest airtime and throughput figures', () => {
    const p = PROFILES.audible;
    expect(rawBitrate(p)).toBeCloseTo(250, 0);
    const t = airtimeSec(p, 100);
    const symbols = HEADER_SYMBOLS + bodySymbols(100);
    expect(t).toBeGreaterThan((symbols * 8) / rawBitrate(p));
    expect((100 * 8) / t).toBeLessThan(rawBitrate(p) * 0.7);
  });
});

describe('framing', () => {
  it('corrects scattered byte errors spread across interleaved blocks and rejects too many', () => {
    const r = rng(9);
    const payload = Uint8Array.from({ length: 200 }, () => Math.floor(r() * 256));
    const sym = encodeBody(payload);
    const conf = new Float64Array(sym.length).fill(1);
    const bad = sym.slice();
    for (let i = 0; i < bad.length; i += 11) bad[i] ^= 0xff;
    const ok = decodeBody(payload.length, bad, conf);
    expect(ok && Array.from(ok.payload)).toEqual(Array.from(payload));
    const worse = sym.slice();
    for (let i = 0; i < worse.length; i += 2) worse[i] ^= 0x33;
    expect(decodeBody(payload.length, worse, conf)).toBeNull();
  });
});
