import { HEADER_BYTES, bodyBytes, decodeBody, decodeHeader } from './framing';
import { BlockSpectra, MatchedFilter, type Peak, PeakPicker, chirpTemplate } from './matched';
import { demodSymbol, mfskSymbols } from './mfsk';
import { OFDM_RATE, type Spectrum, bodyOffset, cpSize, derotate, fftSize, headerSteps, ofdmSymbols, readBytes, spectrum, stepSlope, stepSlopes, steps } from './ofdm';
import { type MfskProfile, type OfdmProfile, type Profile, type ProfileId, bandHz, bytesPerSymbol, preambleSec, symbolSec } from './profiles';
import { SampleStore } from './sample-store';

export interface DecodedFrame {
  payload: Uint8Array;
  profile: ProfileId;
  /** Absolute sample index (in the receiver's stream) where the frame began. */
  startSample: number;
  airtimeSec: number;
  /** Estimated transmitter/receiver sample-clock ratio. 1.003 = sender's clock 0.3% fast. */
  clockRatio: number;
  /** Link quality in dB: winning tone over its rivals (MFSK), or phase-noise SNR of the steps (OFDM). */
  toneSnrDb: number;
  /** Bytes repaired by Reed-Solomon. */
  corrected: number;
}

interface ReceiverListener {
  frame(f: DecodedFrame): void;
  sync?(profile: ProfileId): void;
  lost?(profile: ProfileId, reason: 'header' | 'body'): void;
}

const RHO_THRESHOLD = 0.09;
/** Sync needs a score this many times the RMS score of the last ~50 ms (see PeakPicker). */
const RHO_CFAR = 4;
/**
 * RMS score, over ~200 ms, above which data symbols of some frame are on air even though we
 * missed its preamble. Measured: white noise 0.019, synthetic speech under 0.025, music 0.026,
 * Resonance data symbols 0.037 to 0.069.
 */
const HUM_BUSY = 0.03;
/** Largest sender/receiver sample-clock mismatch that sync accepts. */
export const MAX_CLOCK_SKEW = 0.012;
/**
 * Seconds of samples the receiver keeps at most. A frame is read once all of it has arrived, so
 * the longest frame any profile can send must fit (modem.test.ts checks).
 */
export const MAX_HISTORY_SEC = 30;
const TRACK_STEP_SEC = 0.0005;
/** How far the chirp pair can misjudge the clock ratio in a room: MFSK headers search this far in pitch. */
const PITCH_SEARCH = 0.0015;

interface Pending {
  /** Absolute sample where the first symbol after the preamble begins. */
  s0: number;
  r: number;
  /** OFDM fine timing: offset of the FFT windows, in OFDM_RATE samples. */
  tau: number;
  len?: number;
  started: number;
  /** MFSK body decisions so far: symbol k is next, and tau and r are where the timing and pitch trackers have got to. */
  body?: { k: number; tau: number; r: number; sym: Uint8Array; conf: Float64Array; snr: number };
}

/** Streaming matched filter and chirp-pair sync for one profile; subclasses demodulate the frame. */
abstract class FrameDecoder<P extends Profile> {
  private readonly filter: MatchedFilter;
  /** The stream's blocks for this profile's chirp length, shared with every profile of that length. */
  private readonly blocks: BlockSpectra;
  private readonly picker: PeakPicker;
  private readonly D: number;
  private peaks: Peak[] = [];
  private blockedUntil = 0;
  pending: Pending | null = null;
  lastActivity = -Infinity;
  /** Mean square score over the last ~200 ms (see HUM_BUSY). */
  hum = 0;
  private readonly humAlpha: number;

  constructor(
    readonly p: P,
    protected readonly fs: number,
    protected readonly store: SampleStore,
    blocksFor: (M: number) => BlockSpectra,
    private readonly listener: ReceiverListener,
  ) {
    this.filter = new MatchedFilter(chirpTemplate(p.chirpLowHz, p.chirpHighHz, Math.round(p.chirpSec * fs) / fs, fs));
    this.blocks = blocksFor(this.filter.M);
    this.picker = new PeakPicker(RHO_THRESHOLD, this.filter.M / 2, 0, 0.5, RHO_CFAR, 1 / (0.05 * fs));
    this.D = (p.chirpSec + p.chirpGapSec) * fs;
    this.humAlpha = 1 / (0.2 * fs);
  }

  /** Oldest absolute sample this decoder still needs. */
  get horizon() {
    return this.pending ? this.pending.s0 - preambleSec(this.p) * this.fs : this.blocks.next - this.D * 1.1;
  }

  /** Scores the blocks this push completed (see Receiver.push), then decodes what it can. */
  process() {
    for (const b of this.blocks.ready) this.filter.correlate(b, this.score);
    if (this.pending) this.advance(this.pending);
  }

  /** Takes one sync score: carrier sense, then the peak picker. */
  private readonly score = (pos: number, rho: number) => {
    this.hum += (rho * rho - this.hum) * this.humAlpha;
    const peak = this.picker.push(pos, rho);
    if (peak) this.onPeak(peak);
  };

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
    this.listener.sync?.(this.p.id);
  }

  /** Decodes as much of the pending frame as the stored samples allow. */
  protected abstract advance(pd: Pending): void;

  protected finish(pd: Pending, failure: 'header' | 'body' | null, end: number) {
    this.pending = null;
    this.blockedUntil = failure === 'header' ? pd.s0 : end;
    if (failure) this.listener.lost?.(this.p.id, failure);
  }

  protected emit(pd: Pending, end: number, payload: Uint8Array, toneSnrDb: number, corrected: number) {
    this.finish(pd, null, end);
    this.listener.frame({
      payload,
      profile: this.p.id,
      startSample: pd.started,
      airtimeSec: (end - pd.started) / this.fs,
      clockRatio: pd.r,
      toneSnrDb,
      corrected,
    });
  }
}

/**
 * A quarter of a bin at the top of the band; 0 where that is coarser than PITCH_SEARCH (audible),
 * since such wide bins need no pitch search or tracking.
 */
function pitchStep(p: MfskProfile) {
  const quarterBin = p.binHz / (4 * bandHz(p)[1]);
  return quarterBin <= PITCH_SEARCH ? quarterBin : 0;
}

class MfskDecoder extends FrameDecoder<MfskProfile> {
  /** The pitch step of the header search and the body's tracker (see pitchStep). */
  private readonly dr = pitchStep(this.p);

  private symbolSamples(r: number) {
    return (symbolSec(this.p) * this.fs) / r;
  }

  private needed(pd: Pending, symbols: number) {
    return pd.s0 + symbols * this.symbolSamples(pd.r) + 0.01 * this.fs;
  }

  /** Symbol k on the grid laid at sync, `tau` late, its tones heard at clock ratio `r`. */
  private demod(pd: Pending, k: number, tau: number, r: number) {
    const start = pd.s0 + tau + k * this.symbolSamples(pd.r);
    return demodSymbol(this.store.data.subarray(0, this.store.length), start - this.store.base, this.p, k, r, this.fs);
  }

  /** The header heard at clock ratio `r`: its length, at the offset that makes its tones cleanest; null if it will not decode. */
  private header(pd: Pending, r: number, maxTau: number) {
    let tau = 0, bestScore = -1;
    for (let t = -maxTau; t <= maxTau + 1e-9; t += 0.001 * this.fs) {
      let score = 0;
      for (let k = 0; k < HEADER_BYTES; k++) score += this.demod(pd, k, t, r).purity;
      if (score > bestScore) { bestScore = score; tau = t; }
    }
    const sym = new Uint8Array(HEADER_BYTES);
    const conf = new Float64Array(HEADER_BYTES);
    for (let k = 0; k < HEADER_BYTES; k++) {
      const d = this.demod(pd, k, tau, r);
      sym[k] = d.byte;
      conf[k] = d.conf;
    }
    const len = decodeHeader(sym, conf);
    return len === null ? null : { len, tau };
  }

  protected advance(pd: Pending) {
    const maxTau = 0.005 * this.fs;
    if (pd.len === undefined) {
      if (this.store.end < this.needed(pd, HEADER_BYTES) + maxTau) return;
      // In a room the chirp pair can misjudge the clock ratio by most of a bin at 19 kHz: a header
      // that will not decode at the ratio sync measured gets the pitches either side, nearest first.
      const pitches = [0];
      for (let j = 1; this.dr && j * this.dr <= PITCH_SEARCH; j++) pitches.push(-j, j);
      for (const j of pitches) {
        const r = pd.r * (1 + j * this.dr);
        const h = this.header(pd, r, maxTau);
        if (!h) continue;
        pd.len = h.len;
        const nb = mfskSymbols(h.len) - HEADER_BYTES;
        pd.body = { k: HEADER_BYTES, tau: h.tau, r, sym: new Uint8Array(nb), conf: new Float64Array(nb), snr: 0 };
        break;
      }
      if (pd.len === undefined) return this.finish(pd, 'header', pd.s0);
    }
    const total = mfskSymbols(pd.len);
    const end = this.needed(pd, total);
    const complete = this.store.end >= end + maxTau;
    const step = TRACK_STEP_SEC * this.fs;
    const S = this.symbolSamples(pd.r);
    const b = pd.body!;
    // Each symbol is decided as soon as every sample its late timing guess reads has arrived (after
    // rounding, that window can end a sample past the symbol; the 2 keeps clear of it), so the work
    // spreads over the frame instead of stalling the push that completes it. Whatever is left when
    // the frame is complete is decided then, from the same samples one pass at the end would read.
    for (; b.k < total && (complete || this.store.end >= pd.s0 + b.tau + step + (b.k + 1) * S + 2); b.k++) {
      // Early-late trackers, in time and in pitch, follow a sender whose clock (or speed) changes
      // during the frame: at 19 kHz a 0.13% change moves every tone by a whole bin.
      const mid = this.demod(pd, b.k, b.tau, b.r);
      const early = this.demod(pd, b.k, b.tau - step, b.r).purity;
      const late = this.demod(pd, b.k, b.tau + step, b.r).purity;
      const low = this.dr && this.demod(pd, b.k, b.tau, b.r * (1 - this.dr)).purity;
      const high = this.dr && this.demod(pd, b.k, b.tau, b.r * (1 + this.dr)).purity;
      if (late > mid.purity && late > early) b.tau += step / 2;
      else if (early > mid.purity && early > late) b.tau -= step / 2;
      if (high > mid.purity && high > low) b.r *= 1 + this.dr / 2;
      else if (low > mid.purity && low > high) b.r *= 1 - this.dr / 2;
      b.sym[b.k - HEADER_BYTES] = mid.byte;
      b.conf[b.k - HEADER_BYTES] = mid.conf;
      b.snr += mid.snr;
    }
    if (!complete) return;
    const res = decodeBody(pd.len, b.sym, b.conf);
    if (!res) return this.finish(pd, 'body', end);
    this.emit(pd, end, res.payload, 10 * Math.log10(b.snr / b.sym.length), res.corrected);
  }
}

/**
 * Reads OFDM frames by resampling the stream onto the OFDM_RATE grid (which also undoes the
 * measured clock ratio), timing every FFT window off the reference symbol, then deciding the
 * phase step each carrier took from one symbol to the next.
 */
class OfdmDecoder extends FrameDecoder<OfdmProfile> {
  private readonly S = fftSize(this.p) + cpSize(this.p);
  private readonly read = (pos: number) => this.store.at(pos);

  /** Receiver samples per OFDM_RATE sample. */
  private stride(pd: Pending) {
    return this.fs / (OFDM_RATE * pd.r);
  }

  /** Absolute sample by which `symbols` symbols (and room for a late window) have arrived. */
  private end(pd: Pending, symbols: number) {
    return pd.s0 + (symbols * this.S + cpSize(this.p)) * this.stride(pd) + 4;
  }

  private spectra(pd: Pending, symbols: number, offset: number): Spectrum[] {
    const k = this.stride(pd);
    return Array.from({ length: symbols }, (_, m) => spectrum(this.p, this.read, pd.s0 + (m * this.S + offset) * k, k));
  }

  protected advance(pd: Pending) {
    const cp = cpSize(this.p);
    if (pd.len === undefined) {
      if (this.store.end < this.end(pd, 2)) return;
      // Silence precedes the reference, so a window anywhere inside its prefix sees it whole. Look
      // early enough to forgive a late sync, then put every window 1 ms ahead of the first path's body.
      const probe = cp - 160;
      pd.tau = probe + bodyOffset(this.p, this.spectra(pd, 1, probe)[0]) - 48;
      const z = steps(this.p, this.spectra(pd, 2, pd.tau), 1);
      const h = readBytes(headerSteps(this.p, derotate(this.p, z, stepSlope(this.p, [z]))), HEADER_BYTES);
      const len = decodeHeader(h.bytes, h.conf);
      if (len === null) return this.finish(pd, 'header', pd.s0);
      pd.len = len;
    }
    const total = ofdmSymbols(this.p, pd.len);
    const end = this.end(pd, total);
    if (this.store.end < end) return;
    const spectra = this.spectra(pd, total, pd.tau);
    const zs = Array.from({ length: total - 2 }, (_, i) => steps(this.p, spectra, i + 2));
    const slopes = stepSlopes(this.p, zs);
    const B = bytesPerSymbol(this.p);
    const bytes = new Uint8Array(zs.length * B);
    const conf = new Float64Array(zs.length * B);
    let err2 = 0;
    zs.forEach((z, i) => {
      const d = readBytes(derotate(this.p, z, slopes[i]), B);
      bytes.set(d.bytes, i * B);
      conf.set(d.conf, i * B);
      err2 += d.err2;
    });
    const nb = bodyBytes(pd.len);
    const res = decodeBody(pd.len, bytes.subarray(0, nb), conf.subarray(0, nb));
    if (!res) return this.finish(pd, 'body', end);
    this.emit(pd, end, res.payload, 10 * Math.log10(zs.length / (2 * err2)), res.corrected);
  }
}

/**
 * Listens to a continuous sample stream on every profile at once and emits decoded frames.
 * Pure TypeScript: the same code runs in a Web Worker, on imported recordings and in Node tests.
 */
export class Receiver {
  private readonly store = new SampleStore();
  /** One BlockSpectra per distinct chirp length, shared by every profile of that length. */
  private readonly spectra = new Map<number, BlockSpectra>();
  private readonly decoders: Array<FrameDecoder<Profile>>;

  constructor(
    readonly fs: number,
    profiles: Profile[],
    listener: ReceiverListener,
  ) {
    const blocksFor = (M: number) => {
      const b = this.spectra.get(M) ?? new BlockSpectra(M);
      this.spectra.set(M, b);
      return b;
    };
    this.decoders = profiles.map((p) =>
      p.kind === 'ofdm' ? new OfdmDecoder(p, fs, this.store, blocksFor, listener) : new MfskDecoder(p, fs, this.store, blocksFor, listener),
    );
  }

  get samplesSeen() {
    return this.store.end;
  }

  /**
   * Carrier sense: true while a frame is arriving, a preamble was heard in the last half second,
   * or the air hums with data symbols whose preamble we missed (we joined mid-frame, or were deaf
   * while sending).
   */
  get busy() {
    const recent = this.store.end - 0.5 * this.fs;
    return this.decoders.some((d) => d.pending || d.lastActivity > recent || d.hum > HUM_BUSY ** 2);
  }

  push(chunk: Float32Array) {
    this.store.push(chunk);
    // Transform each new block once, then let each decoder in turn score all of them and decode:
    // the listener hears all of one profile's events, then the next profile's.
    for (const s of this.spectra.values()) s.advance(this.store);
    for (const d of this.decoders) d.process();
    const keep = Math.max(Math.min(...this.decoders.map((d) => d.horizon)), this.store.end - MAX_HISTORY_SEC * this.fs);
    if (keep - this.store.base > 4 * this.fs) this.store.trimBefore(keep);
  }
}
