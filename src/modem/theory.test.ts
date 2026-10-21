import { describe, expect, it } from 'vitest';
import { gaussian, rng } from './channel-sim';
import { encodeBody, encodeHeader } from './framing';
import { modulate } from './modulator';
import { OFDM_RATE, carriersOf, cpSize, derotate, fftSize, ofdmSymbols, readBytes, spectrum, stepSlopes, steps } from './ofdm';
import { PROFILES, TONES_PER_GROUP, bytesPerSymbol, preambleSec, symbolSec, windowSec } from './profiles';
import { demodSymbol } from './receiver';

// An outside judge for the demodulators: textbook theory, not our own expectations.
// Each MFSK tone group is non-coherent orthogonal 16-FSK with square-law detection, whose symbol
// error rate in white Gaussian noise has a closed form (Proakis, Digital Communications, 4.5-43):
//   Ps = Σ_{n=1}^{M-1} (-1)^{n+1} C(M-1, n) / (n+1) · exp(-n/(n+1) · Es/N0)
// Each OFDM carrier is differentially detected 4-PSK, whose symbol error rate Pawula, Rice and
// Roberts (IEEE Trans. Commun., 1982) reduced to a single integral:
//   Ps = sin(π/M)/2π · ∫_{-π/2}^{π/2} exp(-Es/N0 · (1 - cos(π/M) cos θ)) / (1 - cos(π/M) cos θ) dθ

export function mfskSer(M: number, esn0: number): number {
  let p = 0;
  let c = 1;
  for (let n = 1; n < M; n++) {
    c = (c * (M - n)) / n;
    p += ((n % 2 ? 1 : -1) * c * Math.exp((-n * esn0) / (n + 1))) / (n + 1);
  }
  return p;
}

export function mdpskSer(M: number, esn0: number): number {
  const c = Math.cos(Math.PI / M);
  const n = 2000;
  let sum = 0;
  for (let i = 0; i <= n; i++) {
    const g = 1 - c * Math.cos(-Math.PI / 2 + (Math.PI * i) / n);
    sum += ((i === 0 || i === n ? 1 : i % 2 ? 4 : 2) * Math.exp(-esn0 * g)) / g;
  }
  return ((Math.sin(Math.PI / M) / (2 * Math.PI)) * sum * Math.PI) / (3 * n);
}

const db = (x: number) => 10 ** (x / 10);

/** Measured 16-ary decision error rate of the real modulator + real demodulator at Es/N0. */
function measureSer(pid: 'audible' | 'ultrasonic', esn0Db: number, frames: number, seed: number) {
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

/** Measured phase-step error rate of the real OFDM modulator + demodulator at Es/N0 per carrier. */
function measureDqpskSer(esn0Db: number, frames: number, seed: number) {
  const p = PROFILES.fast;
  const fs = OFDM_RATE;
  const r = rng(seed);
  const B = bytesPerSymbol(p);
  const symbols = ofdmSymbols(p, 255);
  // FFT windows placed where the receiver puts them: 1 ms before the end of each cyclic prefix.
  const window = (m: number) => preambleSec(p) * fs + m * (fftSize(p) + cpSize(p)) + cpSize(p) - 48;
  let errors = 0;
  let total = 0;
  for (let f = 0; f < frames; f++) {
    const payload = Uint8Array.from({ length: 255 }, () => Math.floor(r() * 256));
    const clean = modulate(payload, p, fs);
    // Es per carrier measured off the clean signal, so it is whatever the limiter really left.
    let es = 0;
    let n = 0;
    for (let m = 2; m < symbols; m++) {
      const y = spectrum(p, (i) => clean[i], window(m), 1);
      for (const k of carriersOf(p, m)) {
        es += y.re[k] ** 2 + y.im[k] ** 2;
        n++;
      }
    }
    // Real white noise of variance σ² puts N·σ² of energy in every FFT bin.
    const sigma = Math.sqrt(es / n / (db(esn0Db) * fftSize(p)));
    const wave = clean.map((v) => v + sigma * gaussian(r));
    const spectra = Array.from({ length: symbols }, (_, m) => spectrum(p, (i) => wave[i], window(m), 1));
    const zs = Array.from({ length: symbols - 2 }, (_, i) => steps(p, spectra, i + 2));
    const slopes = stepSlopes(p, zs);
    const body = encodeBody(payload);
    zs.forEach((z, i) => {
      const got = readBytes(derotate(p, z, slopes[i]), B).bytes;
      for (let b = 0; b < B && i * B + b < body.length; b++) {
        for (let d = 0; d < 8; d += 2) errors += Number(((got[b] >> d) & 3) !== ((body[i * B + b] >> d) & 3));
        total += 4;
      }
    });
  }
  return errors / total;
}

describe('OFDM demodulator vs. differential 4-PSK theory', () => {
  it('the integral matches known values', () => {
    // Binary DPSK collapses to the familiar ½·exp(-Eb/N0).
    expect(mdpskSer(2, db(8))).toBeCloseTo(0.5 * Math.exp(-db(8)), 12);
    expect(mdpskSer(4, db(10))).toBeCloseTo(0.0173, 4);
  });

  it('fast: within 0.25 dB of the ideal differential detector from 4 to 10 dB Es/N0', () => {
    for (const esn0 of [4, 7, 10]) {
      const measured = measureDqpskSer(esn0, 6, esn0 * 11 + 3);
      process.stderr.write(`fast Es/N0 ${esn0} dB: measured ${measured.toExponential(2)}, theory ${mdpskSer(4, db(esn0)).toExponential(2)}\n`);
      expect(measured).toBeLessThanOrEqual(mdpskSer(4, db(esn0 - 0.25)));
      expect(measured).toBeGreaterThanOrEqual(mdpskSer(4, db(esn0 + 0.25)));
    }
  });
});
