import { fadeEdges, goertzel } from './dsp';
import { HEADER_BYTES, bodyBytes, encodeBody, encodeHeader } from './framing';
import { type MfskProfile, TONES_PER_GROUP, preambleSec, symbolSec, windowSec } from './profiles';

// The MFSK air interface behind the audible and near-ultrasonic profiles (see MfskProfile).
// After the chirp preamble a frame carries one byte per symbol: the 9-byte header codeword, then
// the Reed-Solomon body. Each group of a symbol sounds one of 16 tones for one of the byte's
// nibbles, and consecutive symbols take turns on `hopSets` disjoint tone sets.

/** The tone frequency carrying nibble `v` in group `g` of symbol `k`. */
export const toneHz = (p: MfskProfile, k: number, g: number, v: number) =>
  p.baseHz + p.binHz * (((k % p.hopSets) * p.groups + g) * TONES_PER_GROUP + v);

/** Header + body symbols in a frame carrying `len` payload bytes. */
export const mfskSymbols = (len: number) => HEADER_BYTES + bodyBytes(len);

/** Adds the header and body symbols for `payload` to `out` (sample rate fs), each tone faded in and out over r samples. */
export function writeMfsk(out: Float32Array, payload: Uint8Array, p: MfskProfile, fs: number, r: number) {
  const symbols = new Uint8Array([...encodeHeader(payload.length), ...encodeBody(payload)]);
  const symStart = preambleSec(p) * fs;
  const symLen = symbolSec(p) * fs;
  const amp = 0.9 / p.groups;
  symbols.forEach((byte, k) => {
    const a = Math.round(symStart + k * symLen);
    // Each tone rings on for one ramp past its symbol, into the next symbol's guard interval,
    // so the receiver's integration window only ever sees it at full, steady amplitude.
    const n = Math.round(symStart + (k + 1) * symLen) - a + r;
    for (let g = 0; g < p.groups; g++) {
      const nibble = g === 0 ? byte >> 4 : byte & 15;
      const w = (2 * Math.PI * toneHz(p, k, g, nibble)) / fs;
      for (let i = 0; i < n && a + i < out.length; i++) out[a + i] += amp * fadeEdges(i, n, r) * Math.cos(w * (a + i));
    }
  });
}

interface SymbolDecision {
  byte: number;
  /** 1 - (runner-up energy / winner energy), worst group. Low values become RS erasures. */
  conf: number;
  /** Winner energy / all energy in its group, averaged over groups. Drives timing. */
  purity: number;
  /** Winner energy / mean of the other tones (linear). */
  snr: number;
}

/**
 * Non-coherent square-law detection of one symbol: for every group, measure the energy of all
 * 16 candidate tones over exactly one tone period (so they are orthogonal) and keep the largest.
 * `start` is the sample index (in x) where symbol k begins, guard interval included; `r` is the
 * transmitter/receiver clock ratio, which scales every frequency and duration.
 */
export function demodSymbol(x: Float32Array, start: number, p: MfskProfile, k: number, r: number, fs: number): SymbolDecision {
  const from = Math.round(start + (p.guardSec * fs) / r);
  const n = Math.round((windowSec(p) * fs) / r);
  let byte = 0;
  let conf = 1;
  let purity = 0;
  let snr = 0;
  for (let g = 0; g < p.groups; g++) {
    let best = 0, e1 = 0, e2 = 0, sum = 0;
    for (let v = 0; v < TONES_PER_GROUP; v++) {
      const e = goertzel(x, from, n, toneHz(p, k, g, v) * r, fs);
      sum += e;
      if (e > e1) {
        e2 = e1;
        e1 = e;
        best = v;
      } else if (e > e2) e2 = e;
    }
    byte = (byte << 4) | best;
    conf = Math.min(conf, e1 > 0 ? 1 - e2 / e1 : 0);
    purity += sum > 0 ? e1 / sum : 0;
    snr += e1 / Math.max(1e-12, (sum - e1) / (TONES_PER_GROUP - 1));
  }
  return { byte, conf, purity: purity / p.groups, snr: snr / p.groups };
}
