import { goertzel, nextPow2 } from './dsp';
import { HEADER_SYMBOLS, bodySymbols, decodeBody, decodeHeader } from './framing';
import { MatchedFilter, type Peak, PeakPicker, chirpTemplate } from './matched';
import { type Profile, type ProfileId, groupTones, preambleSec, symbolSec, windowSec } from './profiles';

export interface DecodedFrame {
  payload: Uint8Array;
  profile: ProfileId;
  /** Absolute sample index (in the receiver's stream) where the frame began. */
  startSample: number;
  airtimeSec: number;
  /** Estimated transmitter/receiver sample-clock ratio. 1.003 = sender's clock 0.3% fast. */
  clockRatio: number;
  /** Mean ratio of the winning tone to the other tones in its group, in dB. */
  toneSnrDb: number;
  /** Bytes repaired by Reed-Solomon. */
  corrected: number;
}

export interface ReceiverListener {
  frame(f: DecodedFrame): void;
  sync?(profile: ProfileId, startSample: number): void;
  lost?(profile: ProfileId, reason: 'header' | 'body'): void;
}

const RHO_THRESHOLD = 0.09;
const MAX_CLOCK_SKEW = 0.012;
const TRACK_STEP_SEC = 0.0005;

export interface SymbolDecision {
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
export function demodSymbol(x: Float32Array, start: number, p: Profile, k: number, r: number, fs: number): SymbolDecision {
  const from = Math.round(start + (p.guardSec * fs) / r);
  const n = Math.round((windowSec(p) * fs) / r);
  let byte = 0;
  let conf = 1;
  let purity = 0;
  let snr = 0;
  for (let g = 0; g < p.groups; g++) {
    const tones = groupTones(p, k, g);
    let best = 0, e1 = 0, e2 = 0, sum = 0;
    for (let v = 0; v < tones.length; v++) {
      const e = goertzel(x, from, n, tones[v] * r, fs);
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
    snr += e1 / Math.max(1e-12, (sum - e1) / (tones.length - 1));
  }
  return { byte, conf, purity: purity / p.groups, snr: snr / p.groups };
}

/** Append-only sample store addressed by absolute index; old samples are discarded on trim. */
class SampleStore {
  data = new Float32Array(1 << 16);
  base = 0;
  length = 0;
  get end() {
    return this.base + this.length;
  }
  push(chunk: Float32Array) {
    if (this.length + chunk.length > this.data.length) {
      const next = new Float32Array(nextPow2(this.length + chunk.length) * 2);
      next.set(this.data.subarray(0, this.length));
      this.data = next;
    }
    this.data.set(chunk, this.length);
    this.length += chunk.length;
  }
  trimBefore(abs: number) {
    const drop = Math.min(this.length, Math.floor(abs - this.base));
    if (drop <= 0) return;
    this.data.copyWithin(0, drop, this.length);
    this.length -= drop;
    this.base += drop;
  }
  view(abs: number, n: number): Float32Array {
    const out = new Float32Array(n);
    const from = abs - this.base;
    for (let i = Math.max(0, -from); i < n && from + i < this.length; i++) out[i] = this.data[from + i];
    return out;
  }
}

interface Pending {
  s0: number;
  r: number;
  tau: number;
  len?: number;
  started: number;
}

/** Streaming matched filter + frame decoder for one profile. */
class ProfileDecoder {
  private readonly filter: MatchedFilter;
  private readonly picker: PeakPicker;
  private readonly D: number;
  private peaks: Peak[] = [];
  private blockedUntil = 0;
  pending: Pending | null = null;
  lastActivity = -Infinity;

  constructor(
    readonly p: Profile,
    private readonly fs: number,
    private readonly store: SampleStore,
    private readonly listener: ReceiverListener,
  ) {
    this.filter = new MatchedFilter(chirpTemplate(p.chirpLowHz, p.chirpHighHz, Math.round(p.chirpSec * fs) / fs, fs));
    this.picker = new PeakPicker(RHO_THRESHOLD, this.filter.M / 2);
    this.D = (p.chirpSec + p.chirpGapSec) * fs;
  }

  /** Oldest absolute sample this decoder still needs. */
  get horizon() {
    return this.pending ? this.pending.s0 - preambleSec(this.p) * this.fs : this.filter.next - this.D * 1.1;
  }

  process() {
    this.filter.run(this.store.end, (abs, n) => this.store.view(abs, n), (pos, rho) => {
      const peak = this.picker.push(pos, rho);
      if (peak) this.onPeak(peak);
    });
    this.advancePending();
  }

  private onPeak(peak: Peak) {
    this.lastActivity = peak.pos;
    if (this.pending || peak.pos < this.blockedUntil) return;
    this.peaks = this.peaks.filter((q) => peak.pos - q.pos < this.D * (1 + MAX_CLOCK_SKEW) + 1);
    let best: Peak | null = null;
    for (const q of this.peaks) {
      const r = this.D / (peak.pos - q.pos);
      if (Math.abs(r - 1) <= MAX_CLOCK_SKEW && (!best || q.rho > best.rho)) best = q;
    }
    this.peaks.push(peak);
    if (!best) return;
    const r = this.D / (peak.pos - best.pos);
    const s0 = peak.pos + ((this.p.chirpSec + this.p.quietSec) * this.fs) / r;
    this.pending = { s0, r, tau: 0, started: best.pos };
    this.peaks = [];
    this.listener.sync?.(this.p.id, best.pos);
  }

  private symbolSamples(r: number) {
    return (symbolSec(this.p) * this.fs) / r;
  }

  private needed(pd: Pending, symbols: number) {
    return pd.s0 + symbols * this.symbolSamples(pd.r) + 0.01 * this.fs;
  }

  private demod(pd: Pending, k: number, tau: number) {
    const start = pd.s0 + tau + k * this.symbolSamples(pd.r);
    return demodSymbol(this.store.data.subarray(0, this.store.length), start - this.store.base, this.p, k, pd.r, this.fs);
  }

  private advancePending() {
    const pd = this.pending;
    if (!pd) return;
    const maxTau = 0.005 * this.fs;
    if (pd.len === undefined) {
      if (this.store.end < this.needed(pd, HEADER_SYMBOLS) + maxTau) return;
      // Fine timing: pick the offset that makes header tones cleanest.
      let bestTau = 0, bestScore = -1;
      for (let tau = -maxTau; tau <= maxTau + 1e-9; tau += 0.001 * this.fs) {
        let score = 0;
        for (let k = 0; k < HEADER_SYMBOLS; k++) score += this.demod(pd, k, tau).purity;
        if (score > bestScore) { bestScore = score; bestTau = tau; }
      }
      pd.tau = bestTau;
      const sym = new Uint8Array(HEADER_SYMBOLS);
      const conf = new Float64Array(HEADER_SYMBOLS);
      for (let k = 0; k < HEADER_SYMBOLS; k++) {
        const d = this.demod(pd, k, pd.tau);
        sym[k] = d.byte;
        conf[k] = d.conf;
      }
      const len = decodeHeader(sym, conf);
      if (len === null) return this.finish(pd, 'header', HEADER_SYMBOLS);
      pd.len = len;
    }
    const total = HEADER_SYMBOLS + bodySymbols(pd.len);
    if (this.store.end < this.needed(pd, total) + maxTau) return;
    this.decodeBodyNow(pd, pd.len, total);
  }

  private decodeBodyNow(pd: Pending, len: number, total: number) {
    const nb = total - HEADER_SYMBOLS;
    const sym = new Uint8Array(nb);
    const conf = new Float64Array(nb);
    const step = TRACK_STEP_SEC * this.fs;
    let tau = pd.tau;
    let snr = 0;
    for (let k = HEADER_SYMBOLS; k < total; k++) {
      // Early-late timing tracker absorbs residual clock error over long frames.
      const mid = this.demod(pd, k, tau);
      const early = this.demod(pd, k, tau - step).purity;
      const late = this.demod(pd, k, tau + step).purity;
      if (late > mid.purity && late > early) tau += step / 2;
      else if (early > mid.purity && early > late) tau -= step / 2;
      sym[k - HEADER_SYMBOLS] = mid.byte;
      conf[k - HEADER_SYMBOLS] = mid.conf;
      snr += mid.snr;
    }
    const res = decodeBody(len, sym, conf);
    if (!res) return this.finish(pd, 'body', total);
    const start = pd.started;
    this.finish(pd, null, total);
    this.listener.frame({
      payload: res.payload,
      profile: this.p.id,
      startSample: start,
      airtimeSec: (this.needed(pd, total) - start) / this.fs,
      clockRatio: pd.r,
      toneSnrDb: 10 * Math.log10(snr / nb),
      corrected: res.corrected,
    });
  }

  private finish(pd: Pending, failure: 'header' | 'body' | null, symbols: number) {
    this.pending = null;
    this.blockedUntil = failure === 'header' ? pd.s0 : this.needed(pd, symbols);
    if (failure) this.listener.lost?.(this.p.id, failure);
  }
}

/**
 * Listens to a continuous sample stream on every profile at once and emits decoded frames.
 * Pure TypeScript: the same code runs in a Web Worker, in Node tests and in the e2e harness.
 */
export class Receiver {
  private readonly store = new SampleStore();
  private readonly decoders: ProfileDecoder[];

  constructor(
    readonly fs: number,
    profiles: Profile[],
    listener: ReceiverListener,
  ) {
    this.decoders = profiles.map((p) => new ProfileDecoder(p, fs, this.store, listener));
  }

  get samplesSeen() {
    return this.store.end;
  }

  /** True while a frame is arriving or a preamble was heard in the last half second. */
  get busy() {
    const recent = this.store.end - 0.5 * this.fs;
    return this.decoders.some((d) => d.pending || d.lastActivity > recent);
  }

  push(chunk: Float32Array) {
    this.store.push(chunk);
    for (const d of this.decoders) d.process();
    const keep = Math.max(Math.min(...this.decoders.map((d) => d.horizon)), this.store.end - 30 * this.fs);
    if (keep - this.store.base > 4 * this.fs) this.store.trimBefore(keep);
  }
}
