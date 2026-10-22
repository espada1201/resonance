import { chirpPhase, fadeEdges } from './dsp';
import { mfskSymbols, writeMfsk } from './mfsk';
import { ofdmSymbols, writeOfdm } from './ofdm';
import { type Profile, preambleSec, symbolSec } from './profiles';

const RAMP_SEC = 0.002;
const TAIL_SEC = 0.03;

/** Seconds a frame carrying `payloadLen` bytes occupies on air. */
export const airtimeSec = (p: Profile, payloadLen: number) =>
  preambleSec(p) + (p.kind === 'mfsk' ? mfskSymbols(payloadLen) : ofdmSymbols(p, payloadLen)) * symbolSec(p) + TAIL_SEC;

/** Turns a payload (1..255 bytes) into a mono waveform in [-1, 1] at sample rate `fs`. */
export function modulate(payload: Uint8Array, p: Profile, fs: number): Float32Array {
  const out = new Float32Array(Math.ceil(airtimeSec(p, payload.length) * fs));
  const r = Math.round(RAMP_SEC * fs);
  const chirpN = Math.round(p.chirpSec * fs);
  for (const startSec of [0, p.chirpSec + p.chirpGapSec]) {
    const s0 = Math.round(startSec * fs);
    for (let i = 0; i < chirpN; i++) out[s0 + i] = 0.9 * fadeEdges(i, chirpN, r) * Math.cos(chirpPhase(p.chirpLowHz, p.chirpHighHz, p.chirpSec, i / fs));
  }
  if (p.kind === 'ofdm') writeOfdm(out, payload, p, fs);
  else writeMfsk(out, payload, p, fs, r);
  return out;
}
