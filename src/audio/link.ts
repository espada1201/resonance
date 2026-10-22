import type { ProfileId } from '../modem/profiles';
import type { DecodedFrame } from '../modem/receiver';
import type { FromWorker, ToWorker } from './protocol';
import { type AirTransport, CannotListen } from './transport';

// The station's ears and voice: the speaker, the microphone and the decoder worker behind it.
// The air is half-duplex: while we transmit, the decoder is muted, or it would hear our own
// frames as if a neighbour had repeated them.

export interface Spectrum {
  bins: Float32Array;
  fs: number;
}

/** What the link tells its owner. */
export interface LinkEvents {
  /** A frame decoded off the air. */
  frame(f: DecodedFrame): void;
  /** A preamble: a frame in this profile is coming in. */
  sync(profile: ProfileId): void;
  /** A frame that could not be read: its header, or a body too damaged to repair. */
  lost(profile: ProfileId, stage: 'header' | 'body'): void;
  /** A Find ping, at this sample position and with this correlation. */
  ping(pos: number, rho: number): void;
  /** The decoder's busy flag flipped, or one of our frames finished playing. */
  changed(): void;
  /** The decoder kept failing and the link gave it up: nothing more is heard. */
  failed(message: string): void;
}

/** A decoder that fails more often than this within the window is given up. */
const MAX_FAILURES = 3;
const FAILURE_WINDOW_MS = 10 * 60_000;

/** Vite bundles the worker only from this literal expression. */
const decoder = () => new Worker(new URL('./rx-worker.ts', import.meta.url), { type: 'module' });

export class AirLink {
  /** The capture rate, once started; 0 before. */
  sampleRate = 0;
  /** The decoder is in the middle of a frame: carrier sense says the air is taken. */
  busy = false;
  /** The profile of the frame coming in, from its preamble to its end. */
  receiving: ProfileId | null = null;
  transmitting: { profile: ProfileId; seconds: number; started: number } | null = null;

  private worker: Worker | null = null;
  private failures: number[] = [];
  private unmute: ReturnType<typeof setTimeout> | null = null;
  private spectrumListeners = new Set<(s: Spectrum) => void>();

  constructor(
    private readonly transport: AirTransport,
    private readonly on: LinkEvents,
    private readonly spawnDecoder: () => Worker = decoder,
  ) {}

  /** What to tell someone whose start() failed: what went wrong, and what to do about it. */
  static explain(err: unknown): string {
    if (err instanceof CannotListen) {
      return err.lack === 'insecure'
        ? 'Resonance can use the microphone only on a secure page. Open it from its https:// address, then try again.'
        : 'This browser cannot listen for Resonance. Open the page in an up-to-date Chrome, Edge, Firefox, Samsung Internet or Safari ' +
            '(on iPhone and iPad, iOS 15.4 or later). If it opened inside another app, open it in your browser instead.';
    }
    switch (err instanceof Error ? err.name : '') {
      case 'NotAllowedError':
      case 'SecurityError':
        return (
          'The microphone is blocked for this page. Allow it in the site settings beside the address bar (on iPhone and iPad: aA, then ' +
          'Website Settings), and check that your device lets this browser use the microphone. Then try again.'
        );
      case 'NotFoundError':
      case 'OverconstrainedError':
        return 'No microphone was found. Connect or switch on a microphone, then try again.';
      case 'NotReadableError':
      case 'AbortError':
        return 'The microphone is busy: another app or tab is using it, perhaps a call or a recording. Close it, then try again.';
    }
    return `${err instanceof Error ? err.message : String(err)} Check that this page may use the microphone, then try again.`;
  }

  /** How long the decoder stays muted after our own frame ends: the tail of our sound still in the capture path. */
  get muteTailMs() {
    return 150 + (this.transport.captureDelayMs ?? 0);
  }

  onSpectrum(fn: (s: Spectrum) => void) {
    this.spectrumListeners.add(fn);
    return () => void this.spectrumListeners.delete(fn);
  }

  /** Starts the decoder, then the microphone and speaker; then tells the decoder the sample rate. */
  async start(volume: number) {
    try {
      this.spawn();
      this.sampleRate = await this.transport.start((chunk) => this.post({ type: 'samples', data: chunk }, [chunk.buffer]));
      this.transport.setVolume(volume);
      this.post({ type: 'init', sampleRate: this.sampleRate });
    } catch (err) {
      this.worker?.terminate();
      this.worker = null;
      throw err;
    }
  }

  setVolume(v: number) {
    this.transport.setVolume(v);
  }

  /**
   * Plays a wave rendered at the link's rate, muting the decoder until its sound has passed.
   * `started` runs once `transmitting` is set and before the decoder is muted.
   */
  async play(wave: Float32Array, profile: ProfileId, started: (seconds: number) => void) {
    const fs = this.sampleRate || 48000;
    const seconds = wave.length / fs;
    this.transmitting = { profile, seconds, started: Date.now() };
    started(seconds);
    // A pending unmute from the previous frame must not cut into this one.
    if (this.unmute) clearTimeout(this.unmute);
    this.post({ type: 'mute', on: true });
    try {
      await this.transport.play(wave, fs);
    } finally {
      this.transmitting = null;
      this.unmute = setTimeout(() => {
        this.unmute = null;
        this.post({ type: 'mute', on: false });
      }, this.muteTailMs);
      this.on.changed();
    }
  }

  private spawn() {
    const w = this.spawnDecoder();
    w.onmessage = (e: MessageEvent<FromWorker>) => this.heard(e.data);
    // A decoder that threw may be left half-way through a frame: replace it, unless it keeps failing.
    w.onerror = (e) => {
      e.preventDefault();
      w.terminate();
      if (this.worker !== w) return;
      this.busy = false;
      const now = Date.now();
      this.failures = [...this.failures.filter((t) => now - t < FAILURE_WINDOW_MS), now];
      if (this.failures.length > MAX_FAILURES) {
        this.worker = null;
        return this.on.failed('The sound decoder keeps failing in this browser. Reload the page to listen again.');
      }
      this.spawn();
      if (this.sampleRate) this.post({ type: 'init', sampleRate: this.sampleRate });
      if (this.transmitting || this.unmute) this.post({ type: 'mute', on: true });
    };
    this.worker = w;
  }

  private post(m: ToWorker, transfer: Transferable[] = []) {
    this.worker?.postMessage(m, transfer);
  }

  private heard(m: FromWorker) {
    switch (m.type) {
      case 'spectrum':
        for (const fn of this.spectrumListeners) fn(m);
        return;
      case 'busy':
        this.busy = m.busy;
        if (!m.busy) this.receiving = null;
        return this.on.changed();
      case 'sync':
        this.receiving = m.profile;
        return this.on.sync(m.profile);
      case 'lost':
        this.receiving = null;
        return this.on.lost(m.profile, m.stage);
      case 'ping':
        return this.on.ping(m.pos, m.rho);
      case 'frame':
        this.receiving = null;
        this.on.frame(m.frame);
    }
  }
}
