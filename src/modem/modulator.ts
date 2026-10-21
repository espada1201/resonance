import { HEADER_BYTES, bodyBytes, encodeBody, encodeHeader } from './framing';
import { ofdmSymbols, writeOfdm } from './ofdm';
import { type MfskProfile, type Profile, preambleSec, symbolSec, toneHz } from './profiles';

const RAMP_SEC = 0.002;
const TAIL_SEC = 0.03;

/** Real-valued linear chirp phase at time t (seconds from chirp start). */
export const chirpPhase = (p: Profile, t: number) =>
  2 * Math.PI * (p.chirpLowHz * t + ((p.chirpHighHz - p.chirpLowHz) * t * t) / (2 * p.chirpSec));

function ramp(i: number, n: number, r: number): number {
  if (i < r) return 0.5 - 0.5 * Math.cos((Math.PI * i) / r);
  if (i >= n - r) return 0.5 - 0.5 * Math.cos((Math.PI * (n - 1 - i)) / r);
  return 1;
}

/** Seconds a frame carrying `payloadLen` bytes occupies on air. */
export const airtimeSec = (p: Profile, payloadLen: number) =>
  preambleSec(p) + (p.kind === 'mfsk' ? HEADER_BYTES + bodyBytes(payloadLen) : ofdmSymbols(p, payloadLen)) * symbolSec(p) + TAIL_SEC;

/** Turns a payload (1..255 bytes) into a mono waveform in [-1, 1] at sample rate `fs`. */
export function modulate(payload: Uint8Array, p: Profile, fs: number): Float32Array {
  const out = new Float32Array(Math.ceil(airtimeSec(p, payload.length) * fs));
  const r = Math.round(RAMP_SEC * fs);
  const chirpN = Math.round(p.chirpSec * fs);
  for (const startSec of [0, p.chirpSec + p.chirpGapSec]) {
    const s0 = Math.round(startSec * fs);
    for (let i = 0; i < chirpN; i++) out[s0 + i] = 0.9 * ramp(i, chirpN, r) * Math.cos(chirpPhase(p, i / fs));
  }
  if (p.kind === 'ofdm') writeOfdm(out, payload, p, fs);
  else writeMfsk(out, payload, p, fs, r);
  return out;
}

function writeMfsk(out: Float32Array, payload: Uint8Array, p: MfskProfile, fs: number, r: number) {
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
      for (let i = 0; i < n && a + i < out.length; i++) out[a + i] += amp * ramp(i, n, r) * Math.cos(w * (a + i));
    }
  });
}
