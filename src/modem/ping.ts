import { MatchedFilter, type Peak, PeakPicker, chirpTemplate } from './matched';

// A ranging ping: a 40 ms down-sweep from 6 kHz to 1.5 kHz. Sweeping down keeps it from
// looking like the up-sweeping frame preambles, and 4.5 kHz of bandwidth gives a correlation
// peak about 0.2 ms wide, i.e. centimetre-level timing once interpolated.

export const PING = { startHz: 6000, endHz: 1500, sec: 0.04, amplitude: 0.9 };
const RAMP_SEC = 0.002;

/** The ping waveform at time t seconds after it starts (0 outside the ping). */
export function pingAt(t: number): number {
  if (t < 0 || t >= PING.sec) return 0;
  const edge = Math.min(t, PING.sec - t);
  const ramp = edge < RAMP_SEC ? 0.5 - 0.5 * Math.cos((Math.PI * edge) / RAMP_SEC) : 1;
  const ph = 2 * Math.PI * (PING.startHz * t + ((PING.endHz - PING.startHz) * t * t) / (2 * PING.sec));
  return PING.amplitude * ramp * Math.cos(ph);
}

export function renderPing(fs: number): Float32Array {
  return Float32Array.from({ length: Math.ceil(PING.sec * fs) }, (_, i) => pingAt(i / fs));
}

/** Streams samples and reports the first-arrival time of every ping it hears. */
export class PingDetector {
  private readonly filter: MatchedFilter;
  private readonly picker: PeakPicker;
  private buf = new Float32Array(1 << 15);
  private base = 0;
  private len = 0;

  constructor(
    fs: number,
    private readonly onPing: (p: Peak) => void,
  ) {
    this.filter = new MatchedFilter(chirpTemplate(PING.startHz, PING.endHz, PING.sec, fs));
    this.picker = new PeakPicker(0.25, this.filter.M, 0.003 * fs, 0.5);
  }

  push(chunk: Float32Array) {
    if (this.len + chunk.length > this.buf.length) {
      const keep = Math.max(0, Math.floor(this.filter.next - this.base));
      this.buf.copyWithin(0, keep, this.len);
      this.len -= keep;
      this.base += keep;
      if (this.len + chunk.length > this.buf.length) {
        const bigger = new Float32Array((this.len + chunk.length) * 2);
        bigger.set(this.buf.subarray(0, this.len));
        this.buf = bigger;
      }
    }
    this.buf.set(chunk, this.len);
    this.len += chunk.length;
    this.filter.run(
      this.base + this.len,
      (abs, n) => this.buf.subarray(abs - this.base, abs - this.base + n),
      (pos, rho) => {
        const peak = this.picker.push(pos, rho);
        if (peak) this.onPing(peak);
      },
    );
  }
}
