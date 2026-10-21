import { describe, expect, it } from 'vitest';
import { gaussian, rng } from './channel-sim';
import { encodeBody, encodeHeader } from './framing';
import { modulate } from './modulator';
import { PROFILES, type ProfileId, TONES_PER_GROUP, preambleSec, symbolSec, windowSec } from './profiles';
import { demodSymbol } from './receiver';

// An outside judge for the demodulator: textbook theory, not our own expectations.
// Each tone group is non-coherent orthogonal 16-FSK with square-law detection, whose symbol
// error rate in white Gaussian noise has a closed form (Proakis, Digital Communications, 4.5-43):
//   Ps = Σ_{n=1}^{M-1} (-1)^{n+1} C(M-1, n) / (n+1) · exp(-n/(n+1) · Es/N0)

export function mfskSer(M: number, esn0: number): number {
  let p = 0;
  let c = 1;
  for (let n = 1; n < M; n++) {
    c = (c * (M - n)) / n;
    p += ((n % 2 ? 1 : -1) * c * Math.exp((-n * esn0) / (n + 1))) / (n + 1);
  }
  return p;
}

const db = (x: number) => 10 ** (x / 10);

/** Measured 16-ary decision error rate of the real modulator + real demodulator at Es/N0. */
function measureSer(pid: ProfileId, esn0Db: number, frames: number, seed: number) {
  const p = PROFILES[pid];
  const fs = 48000;
  const r = rng(seed);
  const amp = 0.9 / p.groups;
  const n = windowSec(p) * fs;
  // Es = amp²·n/2 per tone; N0 = 2σ² for real white noise  =>  Es/N0 = amp²·n / (4σ²)
  const sigma = amp * Math.sqrt(n / (4 * db(esn0Db)));
  let errors = 0;
  let total = 0;
  for (let f = 0; f < frames; f++) {
    const payload = Uint8Array.from({ length: 255 }, () => Math.floor(r() * 256));
    const symbols = [...encodeHeader(payload.length), ...encodeBody(payload)];
    const wave = modulate(payload, p, fs).map((v) => v + sigma * gaussian(r));
    symbols.forEach((sym, k) => {
      const d = demodSymbol(wave, preambleSec(p) * fs + k * symbolSec(p) * fs, p, k, 1, fs);
      errors += Number(d.byte >> 4 !== sym >> 4) + Number((d.byte & 15) !== (sym & 15));
      total += 2;
    });
  }
  return errors / total;
}

describe('demodulator vs. non-coherent M-FSK theory', () => {
  it('the closed form matches known values', () => {
    // Binary FSK collapses to the familiar ½·exp(-Es/2N0).
    expect(mfskSer(2, db(10))).toBeCloseTo(0.5 * Math.exp(-5), 12);
    expect(mfskSer(TONES_PER_GROUP, 0)).toBeCloseTo(15 / 16, 12);
  });

  it.each(['audible', 'ultrasonic'] as const)('%s: within 0.25 dB of the ideal detector from 4 to 10 dB Es/N0', (pid) => {
    for (const esn0 of [4, 7, 10]) {
      const measured = measureSer(pid, esn0, 6, esn0 * 7 + 1);
      process.stderr.write(`${pid} Es/N0 ${esn0} dB: measured ${measured.toExponential(2)}, theory ${mfskSer(16, db(esn0)).toExponential(2)}, theory-0.25dB ${mfskSer(16, db(esn0 - 0.25)).toExponential(2)}\n`);
      expect(measured).toBeLessThanOrEqual(mfskSer(TONES_PER_GROUP, db(esn0 - 0.25)));
      expect(measured).toBeGreaterThanOrEqual(mfskSer(TONES_PER_GROUP, db(esn0 + 0.25)));
    }
  });
});
