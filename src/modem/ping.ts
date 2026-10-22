import { chirpPhase, raisedEdge } from './dsp';
import { BlockSpectra, MatchedFilter, type Peak, PeakPicker, chirpTemplate } from './matched';
import { SampleStore } from './sample-store';

// A ranging ping: a 40 ms down-sweep from 6 kHz to 1.5 kHz. Sweeping down keeps it from
// looking like the up-sweeping frame preambles, and 4.5 kHz of bandwidth gives a correlation
// peak about 0.2 ms wide, i.e. centimetre-level timing once interpolated.

export const PING = { startHz: 6000, endHz: 1500, sec: 0.04, amplitude: 0.9 };
const RAMP_SEC = 0.002;

/** The ping waveform at time t seconds after it starts (0 outside the ping). */
export function pingAt(t: number): number {
  if (t < 0 || t >= PING.sec) return 0;
  return PING.amplitude * raisedEdge(Math.min(t, PING.sec - t), RAMP_SEC) * Math.cos(chirpPhase(PING.startHz, PING.endHz, PING.sec, t));
}

export function renderPing(fs: number): Float32Array {
  return Float32Array.from({ length: Math.ceil(PING.sec * fs) }, (_, i) => pingAt(i / fs));
}

/** Streams samples and reports the first-arrival time of every ping it hears. */
export class PingDetector {
  private readonly store = new SampleStore();
  private readonly filter: MatchedFilter;
  private readonly blocks: BlockSpectra;
  private readonly picker: PeakPicker;

  constructor(
    fs: number,
    private readonly onPing: (p: Peak) => void,
  ) {
    this.filter = new MatchedFilter(chirpTemplate(PING.startHz, PING.endHz, PING.sec, fs));
    this.blocks = new BlockSpectra(this.filter.M);
    this.picker = new PeakPicker(0.25, this.filter.M, 0.003 * fs, 0.5);
  }

  push(chunk: Float32Array) {
    this.store.push(chunk);
    for (const b of this.blocks.advance(this.store)) this.filter.correlate(b, this.score);
    // Only the block in progress is read again.
    this.store.trimBefore(this.blocks.next);
  }

  private readonly score = (pos: number, rho: number) => {
    const peak = this.picker.push(pos, rho);
    if (peak) this.onPing(peak);
  };
}
