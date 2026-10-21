import { fft } from './dsp';
import { HEADER_BYTES, bodyBytes, encodeBody, encodeHeader } from './framing';
import { type OfdmProfile, bytesPerSymbol, preambleSec, symbolSec } from './profiles';

// The OFDM air interface behind the "fast" profile (see OfdmProfile). After the chirp preamble
// a frame holds a reference symbol of known phases on every carrier, a header symbol with copies
// of the 9-byte header codeword, then the Reed-Solomon body. Symbols after the reference take
// turns on `hopSets` interleaved carrier sets, and each carrier's 2 bits are the phase step since
// that carrier last sounded.

/** Receivers resample OFDM frames to this rate, where every carrier lands on an FFT bin. */
export const OFDM_RATE = 48000;
/** RMS of the summed carriers; the rare peaks beyond 0.75 are softly limited to stay under 0.9. */
const RMS = 0.3;
const TAPER_SEC = 0.0006;
/** Phase step in quarter turns for each 2-bit value: a Gray code, and its own inverse. */
const GRAY = [0, 1, 3, 2];
const SLOPE_STEP = 2.5e-4;
const SLOPE_STEPS = 16;

export const fftSize = (p: OfdmProfile) => Math.round(p.fftSec * OFDM_RATE);
export const cpSize = (p: OfdmProfile) => Math.round(p.cpSec * OFDM_RATE);
export const firstBin = (p: OfdmProfile) => Math.round(p.firstHz * p.fftSec);
/** Reference + header + body symbols in a frame carrying `len` payload bytes. */
export const ofdmSymbols = (p: OfdmProfile, len: number) => 2 + Math.ceil(bodyBytes(len) / bytesPerSymbol(p));
const headerCopies = (p: OfdmProfile) => Math.floor(bytesPerSymbol(p) / HEADER_BYTES);

/** Carrier indices sounding in symbol m (the reference, m = 0, sounds them all). */
export function carriersOf(p: OfdmProfile, m: number): number[] {
  const set = m === 0 ? 0 : (m - 1) % p.hopSets;
  const step = m === 0 ? 1 : p.hopSets;
  const out: number[] = [];
  for (let k = set; k < p.carriers; k += step) out.push(k);
  return out;
}

/** The symbol whose phases symbol m's carriers step from: the last time they sounded. */
export const previousOf = (p: OfdmProfile, m: number) => Math.max(0, m - p.hopSets);

/** Reference phases (radians): Schroeder's, which keep a flat multi-tone's peaks low. */
const refPhase = (p: OfdmProfile, k: number) => (Math.PI * k * k) / p.carriers;

const dibit = (bytes: Uint8Array, j: number) => (bytes[j >> 2] >> (6 - 2 * (j & 3))) & 3;

/** Quarter turns each carrier has stepped away from its reference phase, symbol by symbol. */
export function frameQuarters(p: OfdmProfile, payload: Uint8Array): Uint8Array[] {
  const B = bytesPerSymbol(p);
  const header = new Uint8Array(B);
  for (let c = 0; c < headerCopies(p); c++) header.set(encodeHeader(payload.length), c * HEADER_BYTES);
  const chunks = [header];
  const body = encodeBody(payload);
  for (let i = 0; i < body.length; i += B) {
    const chunk = new Uint8Array(B);
    chunk.set(body.subarray(i, i + B));
    chunks.push(chunk);
  }
  let q = new Uint8Array(p.carriers);
  const out = [q];
  chunks.forEach((bytes, i) => {
    q = q.slice();
    carriersOf(p, i + 1).forEach((k, j) => {
      if (j < 4 * B) q[k] = (q[k] + GRAY[dibit(bytes, j)]) & 3;
    });
    out.push(q);
  });
  return out;
}

/** Adds the reference, header and body symbols for `payload` to `out` (sample rate fs). */
export function writeOfdm(out: Float32Array, payload: Uint8Array, p: OfdmProfile, fs: number) {
  // Every symbol after the reference sounds 1/hopSets of the carriers, each at this amplitude.
  const amp = RMS * Math.sqrt((2 * p.hopSets) / p.carriers);
  const sym = symbolSec(p);
  const t0 = preambleSec(p);
  const taper = Math.round(TAPER_SEC * fs);
  frameQuarters(p, payload).forEach((quarters, m) => {
    const a = Math.round((t0 + m * sym) * fs);
    // Each symbol runs one taper past its end (a cyclic suffix) and fades in and out over it,
    // overlapping its neighbours only inside the cyclic prefix, which receivers discard.
    const n = Math.round((t0 + (m + 1) * sym) * fs) - a + taper;
    const body = t0 + m * sym + p.cpSec;
    const acc = new Float64Array(n);
    for (const k of carriersOf(p, m)) {
      const hz = p.firstHz + k / p.fftSec;
      const ph = 2 * Math.PI * hz * (a / fs - body) + refPhase(p, k) + (Math.PI / 2) * quarters[k];
      const cw = Math.cos((2 * Math.PI * hz) / fs);
      const sw = Math.sin((2 * Math.PI * hz) / fs);
      let c = Math.cos(ph);
      let s = Math.sin(ph);
      for (let i = 0; i < n; i++) {
        acc[i] += c;
        const t = c * cw - s * sw;
        s = s * cw + c * sw;
        c = t;
      }
    }
    for (let i = 0; i < n && a + i < out.length; i++) {
      const fade = i < taper ? 0.5 - 0.5 * Math.cos((Math.PI * i) / taper) : i >= n - taper ? 0.5 - 0.5 * Math.cos((Math.PI * (n - 1 - i)) / taper) : 1;
      out[a + i] += amp * fade * acc[i];
    }
  });
  for (let i = Math.round(t0 * fs); i < out.length; i++) {
    const v = Math.abs(out[i]);
    if (v > 0.75) out[i] = Math.sign(out[i]) * (0.75 + 0.15 * Math.tanh((v - 0.75) / 0.15));
  }
}

export interface Spectrum {
  re: Float64Array;
  im: Float64Array;
}

/** All carriers of one symbol: the FFT of fftSize samples read through `at` from `start` in steps of `step`. */
export function spectrum(p: OfdmProfile, at: (pos: number) => number, start: number, step: number): Spectrum {
  const N = fftSize(p);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = at(start + i * step);
  fft(re, im);
  const b = firstBin(p);
  return { re: re.slice(b, b + p.carriers), im: im.slice(b, b + p.carriers) };
}

/**
 * Where the first strong path's symbol body began, in OFDM_RATE samples after the start of the
 * FFT window `ref` was measured through (negative: before it). Read off the room's impulse
 * response, which dividing out the reference symbol's known phases reveals.
 */
export function bodyOffset(p: OfdmProfile, ref: Spectrum): number {
  const N = fftSize(p);
  const b = firstBin(p);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let k = 0; k < p.carriers; k++) {
    const c = Math.cos(refPhase(p, k));
    const s = Math.sin(refPhase(p, k));
    re[b + k] = ref.re[k] * c + ref.im[k] * s;
    im[b + k] = ref.im[k] * c - ref.re[k] * s;
  }
  fft(re, im, true);
  const pow = new Float64Array(N);
  let peak = 0;
  for (let n = 0; n < N; n++) {
    pow[n] = re[n] * re[n] + im[n] * im[n];
    if (pow[n] > pow[peak]) peak = n;
  }
  // The loudest path is often a reflection: take the earliest one within 4 ms holding a quarter of its power.
  const at = (n: number) => pow[(n + N) % N];
  let first = peak;
  for (let n = peak - Math.round(0.004 * OFDM_RATE); n < peak; n++) {
    if (at(n) >= 0.25 * pow[peak] && at(n) >= at(n - 1) && at(n) >= at(n + 1)) {
      first = n;
      break;
    }
  }
  first = (first + N) % N;
  return first > N / 2 ? first - N : first;
}

/** The phase steps one symbol's carriers took since they last sounded: z = cur · conj(prev). */
export interface Steps {
  ks: number[];
  re: Float64Array;
  im: Float64Array;
  /** Symbol periods between the two soundings. */
  span: number;
}

export function steps(p: OfdmProfile, spectra: Spectrum[], m: number): Steps {
  const ks = carriersOf(p, m);
  const prev = previousOf(p, m);
  const a = spectra[prev];
  const c = spectra[m];
  const re = new Float64Array(ks.length);
  const im = new Float64Array(ks.length);
  ks.forEach((k, j) => {
    re[j] = c.re[k] * a.re[k] + c.im[k] * a.im[k];
    im[j] = c.im[k] * a.re[k] - c.re[k] * a.im[k];
  });
  return { ks, re, im, span: m - prev };
}

/**
 * A small error left in the clock-ratio estimate (or a sender on the move) makes each symbol land
 * slightly later or earlier than the last, which turns every phase step by an angle proportional
 * to frequency and to the time between soundings. Returns that slope in radians per FFT bin per
 * symbol: refined from both zero and a coarse blind estimate, keeping whichever fits better,
 * because the blind estimate alone wanders when the signal is weak.
 */
export function stepSlope(p: OfdmProfile, all: Steps[]): number {
  const [a, b] = [0, blindSlope(p, all)].map((s) => refineSlope(p, all, s));
  return a.err2 <= b.err2 ? a.slope : b.slope;
}

/**
 * One slope per step. A sender that speeds up or slows down mid-frame (a phone in a moving hand)
 * makes the slope drift, so a tracker follows it step by step: it turns each step by the slope
 * predicted from the steps before, then moves the prediction toward what that step's confident
 * decisions show (an alpha-beta filter). It is kept only when it fits clearly better than one
 * slope for the whole frame, which in steady conditions is the less noisy choice.
 */
export function stepSlopes(p: OfdmProfile, all: Steps[]): number[] {
  const flat = stepSlope(p, all);
  const constant = all.map(() => flat);
  let s = stepSlope(p, all.slice(0, 3));
  let v = 0;
  const tracked = all.map((z) => {
    const predicted = s + v;
    const residual = refineSlope(p, [z], predicted).slope - predicted;
    s = predicted + 0.5 * residual;
    v += 0.15 * residual;
    return s;
  });
  return fitError(p, all, tracked) < 0.8 * fitError(p, all, constant) ? tracked : constant;
}

function fitError(p: OfdmProfile, all: Steps[], slopes: number[]) {
  return all.reduce((sum, z, i) => sum + refineSlope(p, [z], slopes[i], 0).err2, 0) / all.length;
}

/** Decision-directed refinement: fit the slope to the phase errors of confident decisions. */
function refineSlope(p: OfdmProfile, all: Steps[], start: number, iterations = 3) {
  const b = firstBin(p);
  let slope = start;
  let err2 = 0;
  for (let iter = 0; iter <= iterations; iter++) {
    let num = 0;
    let den = 0;
    let n = 0;
    err2 = 0;
    for (const z of all) {
      for (let j = 0; j < z.ks.length; j++) {
        const x = z.span * (b + z.ks[j]);
        const ang = Math.atan2(z.im[j], z.re[j]) - slope * x;
        const e = ang - Math.round(ang / (Math.PI / 2)) * (Math.PI / 2);
        err2 += e * e;
        n++;
        if (Math.abs(e) > Math.PI / 6) continue;
        const w = Math.hypot(z.re[j], z.im[j]);
        num += w * e * x;
        den += w * x * x;
      }
    }
    err2 /= n;
    if (iter < iterations && den > 0) slope += num / den;
  }
  return { slope, err2 };
}

/** Maximises the coherence of the steps raised to the 4th power, which erases the data (multiples of a quarter turn) but not the slope. */
function blindSlope(p: OfdmProfile, all: Steps[]): number {
  const b = firstBin(p);
  const w = all.map((z) => {
    const wr = new Float64Array(z.ks.length);
    const wi = new Float64Array(z.ks.length);
    for (let j = 0; j < z.ks.length; j++) {
      const r2 = z.re[j] * z.re[j] + z.im[j] * z.im[j];
      if (r2 === 0) continue;
      const sr = z.re[j] * z.re[j] - z.im[j] * z.im[j];
      const si = 2 * z.re[j] * z.im[j];
      const norm = 1 / (r2 * Math.sqrt(r2));
      wr[j] = (sr * sr - si * si) * norm;
      wi[j] = 2 * sr * si * norm;
    }
    return { wr, wi };
  });
  const score = (slope: number) => {
    let sr = 0;
    let si = 0;
    all.forEach((z, i) => {
      for (let j = 0; j < z.ks.length; j++) {
        const a = -4 * slope * z.span * (b + z.ks[j]);
        const c = Math.cos(a);
        const s = Math.sin(a);
        sr += w[i].wr[j] * c - w[i].wi[j] * s;
        si += w[i].wr[j] * s + w[i].wi[j] * c;
      }
    });
    return sr * sr + si * si;
  };
  let best = 0;
  let top = -1;
  for (let i = -SLOPE_STEPS; i <= SLOPE_STEPS; i++) {
    const v = score(i * SLOPE_STEP);
    if (v > top) {
      top = v;
      best = i * SLOPE_STEP;
    }
  }
  const l = score(best - SLOPE_STEP);
  const r = score(best + SLOPE_STEP);
  const den = l - 2 * top + r;
  return den < 0 ? best + (0.5 * SLOPE_STEP * (l - r)) / den : best;
}

/** Turns each step back by the slope's angle for its carrier and span. */
export function derotate(p: OfdmProfile, z: Steps, slope: number): Steps {
  const b = firstBin(p);
  const re = new Float64Array(z.ks.length);
  const im = new Float64Array(z.ks.length);
  z.ks.forEach((k, j) => {
    const a = -slope * z.span * (b + k);
    const c = Math.cos(a);
    const s = Math.sin(a);
    re[j] = z.re[j] * c - z.im[j] * s;
    im[j] = z.re[j] * s + z.im[j] * c;
  });
  return { ...z, re, im };
}

/** Adds up the header's copies, carrier by carrier, so they decide together. */
export function headerSteps(p: OfdmProfile, z: Steps): Steps {
  const n = HEADER_BYTES * 4;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let c = 0; c < headerCopies(p); c++) {
    for (let j = 0; j < n; j++) {
      re[j] += z.re[c * n + j];
      im[j] += z.im[c * n + j];
    }
  }
  return { ks: z.ks.slice(0, n), re, im, span: z.span };
}

export interface ByteDecisions {
  bytes: Uint8Array;
  /** Per byte, 0..1: the worst of its four carriers' distance from a decision boundary, scaled down on faded carriers. */
  conf: Float64Array;
  /** Mean squared phase error (radians²), a direct measure of the link's signal-to-noise ratio. */
  err2: number;
}

/** Reads `count` bytes from derotated phase steps, four carriers (2 bits each) per byte. */
export function readBytes(z: Steps, count: number): ByteDecisions {
  const n = count * 4;
  const mags = Array.from({ length: n }, (_, j) => Math.hypot(z.re[j], z.im[j]));
  const typical = [...mags].sort((a, b) => a - b)[n >> 1] || 1;
  const bytes = new Uint8Array(count);
  const conf = new Float64Array(count).fill(1);
  let err2 = 0;
  for (let j = 0; j < n; j++) {
    const ang = Math.atan2(z.im[j], z.re[j]);
    const q = Math.round(ang / (Math.PI / 2));
    const e = ang - (q * Math.PI) / 2;
    err2 += e * e;
    bytes[j >> 2] |= GRAY[q & 3] << (6 - 2 * (j & 3));
    conf[j >> 2] = Math.min(conf[j >> 2], (1 - Math.abs(e) / (Math.PI / 4)) * Math.min(1, mags[j] / typical));
  }
  return { bytes, conf, err2: err2 / n };
}
