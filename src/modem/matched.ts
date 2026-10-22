import { chirpPhase, fft, nextPow2 } from './dsp';

// Streaming normalised matched filtering, shared by frame sync and acoustic ranging.

interface Template {
  re: Float64Array;
  im: Float64Array;
}

/** Complex (analytic) linear chirp from f0 to f1 Hz lasting `sec` seconds at rate fs. */
export function chirpTemplate(f0: number, f1: number, sec: number, fs: number): Template {
  const n = Math.round(sec * fs);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const ph = chirpPhase(f0, f1, sec, i / fs);
    re[i] = Math.cos(ph);
    im[i] = Math.sin(ph);
  }
  return { re, im };
}

/** Overlap-save block length for templates of length M: at least four template lengths. */
const blockSize = (M: number) => nextPow2(M * 4);

/** One overlap-save block of a stream: its spectrum, and the running energy of its samples. */
export interface Block {
  /** Absolute index of the block's first sample, which is also its first lag. */
  start: number;
  readonly re: Float64Array;
  readonly im: Float64Array;
  /** cum[i] = energy of the block's first i samples. */
  readonly cum: Float64Array;
}

/** A sample stream addressed by absolute index (see SampleStore). */
interface Stream {
  readonly end: number;
  view(abs: number, n: number): Float32Array;
}

/**
 * Cuts a stream into the overlap-save blocks that templates of length M correlate with, and
 * transforms each block once, however many templates read it.
 */
export class BlockSpectra {
  private readonly N: number;
  /** New lags per block. */
  private readonly L: number;
  /** Absolute index of the next lag to evaluate: the start of the next block. */
  next = 0;
  private readonly done: Block[] = [];
  /** Buffers for as many blocks as one advance() has completed at most. */
  private readonly pool: Block[] = [];

  constructor(M: number) {
    this.N = blockSize(M);
    this.L = this.N - M + 1;
  }

  /** The blocks the last advance() completed, oldest first. The next advance() reuses their buffers. */
  get ready(): readonly Block[] {
    return this.done;
  }

  /** Transforms every block the stream now completes. */
  advance(s: Stream): readonly Block[] {
    const { N, L, done } = this;
    done.length = 0;
    while (s.end >= this.next + N) {
      const b = (this.pool[done.length] ??= { start: 0, re: new Float64Array(N), im: new Float64Array(N), cum: new Float64Array(N + 1) });
      const { re, im, cum } = b;
      const x = s.view(this.next, N);
      im.fill(0);
      for (let i = 0; i < N; i++) {
        re[i] = x[i];
        cum[i + 1] = cum[i] + x[i] * x[i];
      }
      fft(re, im);
      b.start = this.next;
      done.push(b);
      this.next += L;
    }
    return done;
  }
}

/**
 * Overlap-save FFT correlation of a sample stream with a complex template, one block of a
 * BlockSpectra (of the template's length) at a time. Emits, for every lag,
 * |<x, t>| / (‖t‖·‖x‖) — a normalised score near 0.7 for a clean real copy of the template
 * (its analytic counterpart scores 1), independent of loudness.
 */
export class MatchedFilter {
  readonly M: number;
  private readonly tRe: Float64Array;
  private readonly tIm: Float64Array;
  private readonly tEnergy: number;
  /** Scratch for one block's correlation. */
  private readonly re: Float64Array;
  private readonly im: Float64Array;

  constructor(t: Template) {
    this.M = t.re.length;
    const N = blockSize(this.M);
    this.tRe = new Float64Array(N);
    this.tIm = new Float64Array(N);
    this.tRe.set(t.re);
    this.tIm.set(t.im);
    let e = 0;
    for (let i = 0; i < this.M; i++) e += t.re[i] * t.re[i] + t.im[i] * t.im[i];
    this.tEnergy = e;
    fft(this.tRe, this.tIm);
    this.re = new Float64Array(N);
    this.im = new Float64Array(N);
  }

  /** Scores every lag of block `b`, in order. */
  correlate(b: Block, onRho: (pos: number, rho: number) => void) {
    const { M, re, im, tRe, tIm } = this;
    const N = re.length;
    const L = N - M + 1;
    for (let i = 0; i < N; i++) {
      // X · conj(T)
      const a = b.re[i], bi = b.im[i], c = tRe[i], d = -tIm[i];
      re[i] = a * c - bi * d;
      im[i] = a * d + bi * c;
    }
    fft(re, im, true);
    for (let n = 0; n < L; n++) {
      const e = b.cum[n + M] - b.cum[n];
      onRho(b.start + n, e > 1e-9 ? Math.hypot(re[n], im[n]) / Math.sqrt(this.tEnergy * e) : 0);
    }
  }
}

export interface Peak {
  /** Sub-sample position (absolute sample index). */
  pos: number;
  rho: number;
}

/**
 * Turns a score stream into discrete peaks: the largest score above `threshold`, reported once
 * nothing larger has appeared for `holdoff` samples. With `lookback` > 0 it reports the first
 * arrival instead — the earliest local maximum within `lookback` samples before the largest one
 * that reaches `firstFrac` of it — because the loudest path in a room is often a reflection.
 * With `cfar` > 0 the threshold also rises to `cfar` times the recent RMS score (a constant
 * false-alarm-rate detector): other transmissions' data raise the score everywhere, and only a
 * true chirp stands that far above it.
 */
export class PeakPicker {
  private readonly hist: Float32Array;
  private cand: Peak | null = null;
  private level = 0;

  constructor(
    private readonly threshold: number,
    private readonly holdoff: number,
    private readonly lookback = 0,
    private readonly firstFrac = 0.5,
    private readonly cfar = 0,
    /** Weight of each new score in the running mean square (1 / its time constant in samples). */
    private readonly alpha = 0,
  ) {
    this.hist = new Float32Array(Math.ceil(holdoff + lookback) + 8);
  }

  private at(pos: number) {
    return pos < 0 ? 0 : this.hist[pos % this.hist.length];
  }

  push(pos: number, rho: number): Peak | null {
    this.hist[pos % this.hist.length] = rho;
    const threshold = Math.max(this.threshold, this.cfar * Math.sqrt(this.level));
    this.level += (rho * rho - this.level) * this.alpha;
    const c = this.cand;
    if (rho > threshold && (!c || rho > c.rho)) {
      this.cand = { pos, rho };
      return null;
    }
    if (!c || pos - c.pos <= this.holdoff) return null;
    this.cand = null;
    let best = c.pos;
    for (let q = Math.ceil(c.pos - this.lookback); q < c.pos; q++) {
      const v = this.at(q);
      if (v >= this.firstFrac * c.rho && v >= this.at(q - 1) && v >= this.at(q + 1)) {
        best = q;
        break;
      }
    }
    const l = this.at(best - 1), m = this.at(best), r = this.at(best + 1);
    const den = l - 2 * m + r;
    const frac = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / den)) : 0;
    return { pos: best + frac, rho: c.rho };
  }
}
