import { describe, expect, it } from 'vitest';
import { twoWayDistance } from '../mesh/ranging';
import { gaussian, rng } from './channel-sim';
import type { Peak } from './matched';
import { PING, PingDetector, pingAt, renderPing } from './ping';
import { PROFILES } from './profiles';
import { Receiver } from './receiver';

const C = 343;

interface Device {
  fs: number;
  /** True time (s) of this device's sample 0, and its clock error (+50e-6 = 50 ppm fast). */
  offset: number;
  skew: number;
  /** Speaker-to-own-mic distance (m). */
  self: number;
}

interface Emission {
  at: number;
  from: 'A' | 'B';
}

/**
 * Renders what one device's microphone records: every ping, delayed by its true propagation
 * time, sampled on this device's own imperfect clock, plus optional echoes and hiss.
 */
function record(dev: Device, me: 'A' | 'B', distance: number, pings: Emission[], opts: { echoes?: Array<[number, number]>; noise?: number; seed?: number } = {}) {
  const seconds = 4;
  const r = rng(opts.seed ?? 1);
  const out = new Float32Array(Math.round(seconds * dev.fs));
  for (let n = 0; n < out.length; n++) {
    const t = dev.offset + n / (dev.fs * (1 + dev.skew));
    let v = 0;
    for (const e of pings) {
      const path = e.from === me ? dev.self : distance;
      const gain = Math.min(1, 0.3 / path);
      v += gain * pingAt(t - e.at - path / C);
      for (const [extraM, g] of opts.echoes ?? []) v += gain * g * pingAt(t - e.at - (path + extraM) / C);
    }
    out[n] = v + (opts.noise ?? 0) * gaussian(r);
  }
  return out;
}

function detect(x: Float32Array, fs: number): Peak[] {
  const found: Peak[] = [];
  const det = new PingDetector(fs, (p) => found.push(p));
  for (let i = 0; i < x.length; i += 1024) det.push(x.subarray(i, i + 1024));
  return found;
}

function measure(distance: number, opts: { echoes?: Array<[number, number]>; noise?: number } = {}) {
  const A: Device = { fs: 48000, offset: 0.013, skew: 40e-6, self: 0.1 };
  const B: Device = { fs: 44100, offset: -0.271, skew: -35e-6, self: 0.1 };
  const pings: Emission[] = [
    { at: 0.8, from: 'A' },
    { at: 2.17, from: 'B' },
  ];
  const a = detect(record(A, 'A', distance, pings, { ...opts, seed: 1 }), A.fs);
  const b = detect(record(B, 'B', distance, pings, { ...opts, seed: 2 }), B.fs);
  expect(a).toHaveLength(2);
  expect(b).toHaveLength(2);
  const intervalA = (a[1].pos - a[0].pos) / A.fs;
  const intervalB = (b[1].pos - b[0].pos) / B.fs;
  return twoWayDistance(intervalA, intervalB, A.self, B.self);
}

describe('two-way acoustic ranging', () => {
  it.each([0.6, 3, 12.5])('measures %f m between two unsynchronised devices to within 2 cm', (d) => {
    expect(Math.abs(measure(d) - d)).toBeLessThan(0.02);
  });

  it('locks onto the direct path even when a reflection is louder', () => {
    const d = 4.2;
    // A wall bounce 0.8 m longer arriving 1.4x louder than the direct sound, plus a later echo.
    const est = measure(d, { echoes: [[0.8, 1.4], [2.5, 0.6]], noise: 0.002 });
    expect(Math.abs(est - d)).toBeLessThan(0.05);
  });

  it('works through background hiss', () => {
    expect(Math.abs(measure(7, { noise: 0.01 }) - 7)).toBeLessThan(0.05);
  });

  it('is not mistaken for a frame preamble', () => {
    const fs = 48000;
    const x = new Float32Array(fs * 2);
    x.set(renderPing(fs), fs / 2);
    x.set(renderPing(fs), fs / 2 + Math.round((PROFILES.audible.chirpSec + PROFILES.audible.chirpGapSec) * fs));
    let syncs = 0;
    const rx = new Receiver(fs, [PROFILES.audible, PROFILES.ultrasonic], { frame: () => undefined, sync: () => syncs++ });
    rx.push(x);
    expect(syncs).toBe(0);
    expect(PING.sec).toBeLessThan(0.05);
  });
});
