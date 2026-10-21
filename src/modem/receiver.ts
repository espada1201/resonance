import { fft, goertzel, nextPow2 } from './dsp';
import { HEADER_SYMBOLS, bodySymbols, decodeBody, decodeHeader } from './framing';
import { chirpPhase } from './modulator';
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
  /** Energy at `hz` over n samples starting at absolute index `abs`. */
  tone(abs: number, n: number, hz: number, fs: number) {
    return goertzel(this.data.subarray(0, this.length), Math.round(abs - this.base), n, hz, fs);
  }
  view(abs: number, n: number): Float32Array {
    const out = new Float32Array(n);
    const from = abs - this.base;
    for (let i = Math.max(0, -from); i < n && from + i < this.length; i++) out[i] = this.data[from + i];
    return out;
  }
}

interface Peak {
  pos: number;
  rho: number;
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
  private readonly M: number;
  private readonly N: number;
  private readonly L: number;
  private readonly tRe: Float64Array;
  private readonly tIm: Float64Array;
  private readonly tEnergy: number;
  private readonly D: number;
  private next = 0;
  private cand: (Peak & { left: number; right: number | null }) | null = null;
  private prevRho = 0;
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
    this.M = Math.round(p.chirpSec * fs);
    this.N = nextPow2(this.M * 4);
    this.L = this.N - this.M + 1;
    this.D = (p.chirpSec + p.chirpGapSec) * fs;
    this.tRe = new Float64Array(this.N);
    this.tIm = new Float64Array(this.N);
    let e = 0;
    for (let i = 0; i < this.M; i++) {
      const ph = chirpPhase(p, i / fs);
      this.tRe[i] = Math.cos(ph);
      this.tIm[i] = Math.sin(ph);
      e += 1;
    }
    this.tEnergy = e;
    fft(this.tRe, this.tIm);
  }

  /** Oldest absolute sample this decoder still needs. */
  get horizon() {
    return this.pending ? this.pending.s0 - preambleSec(this.p) * this.fs : this.next - this.D * 1.1;
  }

  process() {
    while (this.store.end >= this.next + this.N) this.correlateBlock();
    this.advancePending();
  }

  private correlateBlock() {
    const { N, M, L } = this;
    const x = this.store.view(this.next, N);
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    const cum = new Float64Array(N + 1);
    for (let i = 0; i < N; i++) {
      re[i] = x[i];
      cum[i + 1] = cum[i] + x[i] * x[i];
    }
    fft(re, im);
    for (let i = 0; i < N; i++) {
      // X * conj(T)
      const a = re[i], b = im[i], c = this.tRe[i], d = -this.tIm[i];
      re[i] = a * c - b * d;
      im[i] = a * d + b * c;
    }
    fft(re, im, true);
    for (let n = 0; n < L; n++) {
      const e = cum[n + M] - cum[n];
      const rho = e > 1e-9 ? Math.hypot(re[n], im[n]) / Math.sqrt(this.tEnergy * e) : 0;
      this.onRho(this.next + n, rho);
    }
    this.next += L;
  }

  private onRho(pos: number, rho: number) {
    const c = this.cand;
    if (c && c.right === null && pos === c.pos + 1) c.right = rho;
    if (rho > RHO_THRESHOLD && (!c || rho > c.rho)) {
      this.cand = { pos, rho, left: this.prevRho, right: null };
    } else if (c && pos - c.pos > this.M / 2) {
      // Parabolic interpolation for a sub-sample peak position.
      const r = c.right ?? c.rho;
      const den = c.left - 2 * c.rho + r;
      const frac = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (c.left - r)) / den)) : 0;
      this.onPeak({ pos: c.pos + frac, rho: c.rho });
      this.cand = null;
    }
    this.prevRho = rho;
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

  /** Demodulates symbol k; returns the byte, its confidence and its tone purity. */
  private demod(pd: Pending, k: number, tau: number) {
    const { p, fs } = this;
    const start = pd.s0 + tau + k * this.symbolSamples(pd.r) + (p.guardSec * fs) / pd.r;
    const n = Math.round((windowSec(p) * fs) / pd.r);
    let byte = 0;
    let conf = 1;
    let purity = 0;
    let snr = 0;
    for (let g = 0; g < p.groups; g++) {
      const tones = groupTones(p, k, g);
      let best = -1, e1 = 0, e2 = 0, sum = 0;
      for (let v = 0; v < tones.length; v++) {
        const e = this.store.tone(start, n, tones[v] * pd.r, fs);
        sum += e;
        if (e > e1) { e2 = e1; e1 = e; best = v; } else if (e > e2) e2 = e;
      }
      byte = (byte << 4) | Math.max(0, best);
      conf = Math.min(conf, e1 > 0 ? 1 - e2 / e1 : 0);
      purity += sum > 0 ? e1 / sum : 0;
      snr += e1 / Math.max(1e-12, (sum - e1) / (tones.length - 1));
    }
    return { byte, conf, purity: purity / p.groups, snr: snr / p.groups };
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
