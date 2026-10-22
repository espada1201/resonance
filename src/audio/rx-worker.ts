/// <reference lib="webworker" />
import { magnitudeSpectrum } from '../modem/dsp';
import { PingDetector } from '../modem/ping';
import { PROFILES } from '../modem/profiles';
import { Receiver } from '../modem/receiver';
import type { FromWorker, ToWorker } from './protocol';

// Runs the demodulator and the ranging-ping detector off the UI thread, and streams spectrum
// frames for the visualiser.

const post = (m: FromWorker, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, transfer);

let rx: Receiver | null = null;
let pings: PingDetector | null = null;
let muted = false;
/** What the receiver hears while muted. One buffer serves every chunk: the receiver copies what it is given. */
let silence = new Float32Array(0);
const recent = new Float32Array(2048);
let sinceSpectrum = 0;
let wasBusy = false;

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (m.type === 'init') {
    const fs = m.sampleRate;
    rx = new Receiver(fs, Object.values(PROFILES), {
      frame: (f) => post({ type: 'frame', frame: f }),
      sync: (profile) => post({ type: 'sync', profile }),
      lost: (profile, stage) => post({ type: 'lost', profile, stage }),
    });
    // Pings are timed on the raw stream, own transmissions included: ranging needs them.
    pings = new PingDetector(fs, (p) => post({ type: 'ping', pos: p.pos, rho: p.rho }));
    sinceSpectrum = 0;
  } else if (m.type === 'mute') {
    muted = m.on;
  } else if (m.type === 'samples' && rx) {
    if (muted && silence.length !== m.data.length) silence = new Float32Array(m.data.length);
    rx.push(muted ? silence : m.data);
    pings?.push(m.data);
    keepRecent(m.data);
    sinceSpectrum += m.data.length;
    if (sinceSpectrum >= rx.fs / 25) {
      sinceSpectrum = 0;
      const bins = magnitudeSpectrum(recent, 2048);
      post({ type: 'spectrum', bins, fs: rx.fs }, [bins.buffer]);
    }
    if (rx.busy !== wasBusy) post({ type: 'busy', busy: (wasBusy = rx.busy) });
  }
};

/** Keeps the last 2048 samples for the spectrum, in place: capture chunks are 2048 long. */
function keepRecent(chunk: Float32Array) {
  if (chunk.length >= recent.length) {
    recent.set(chunk.subarray(chunk.length - recent.length));
    return;
  }
  recent.copyWithin(0, chunk.length);
  recent.set(chunk, recent.length - chunk.length);
}
