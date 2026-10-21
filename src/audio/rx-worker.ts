/// <reference lib="webworker" />
import { magnitudeSpectrum } from '../modem/dsp';
import { PROFILES } from '../modem/profiles';
import { Receiver } from '../modem/receiver';
import type { FromWorker, ToWorker } from './protocol';

// Runs the demodulator off the UI thread and streams spectrum frames for the visualiser.

const post = (m: FromWorker, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, transfer);

let rx: Receiver | null = null;
let muted = false;
let recent = new Float32Array(2048);
let sinceSpectrum = 0;
let wasBusy = false;

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (m.type === 'init') {
    const fs = m.sampleRate;
    rx = new Receiver(fs, [PROFILES.audible, PROFILES.ultrasonic], {
      frame: (f) => post({ type: 'frame', frame: f }),
      sync: (profile) => post({ type: 'sync', profile }),
      lost: (profile, stage) => post({ type: 'lost', profile, stage }),
    });
    sinceSpectrum = 0;
  } else if (m.type === 'mute') {
    muted = m.on;
  } else if (m.type === 'samples' && rx) {
    const chunk = muted ? new Float32Array(m.data.length) : m.data;
    rx.push(chunk);
    keepRecent(m.data);
    sinceSpectrum += m.data.length;
    if (sinceSpectrum >= rx.fs / 25) {
      sinceSpectrum = 0;
      let peak = 0;
      for (const v of recent) peak = Math.max(peak, Math.abs(v));
      const bins = magnitudeSpectrum(recent, 2048);
      post({ type: 'spectrum', bins, peak, fs: rx.fs }, [bins.buffer]);
    }
    if (rx.busy !== wasBusy) post({ type: 'busy', busy: (wasBusy = rx.busy) });
  }
};

function keepRecent(chunk: Float32Array) {
  if (chunk.length >= recent.length) {
    recent = chunk.slice(chunk.length - recent.length);
    return;
  }
  recent.copyWithin(0, chunk.length);
  recent.set(chunk, recent.length - chunk.length);
}
