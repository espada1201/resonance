import { gaussian } from '../modem/channel-sim';

/** Where sound comes from and goes to. Production uses the mic and speaker; tests and the
 *  two-tab demo use a simulated room shared between pages of the same origin. */
export interface AirTransport {
  readonly kind: 'mic' | 'simulated';
  /** How far capture runs behind real time, beyond normal audio latency. */
  readonly captureDelayMs?: number;
  /** Starts capture; resolves with the capture sample rate. */
  start(onSamples: (chunk: Float32Array) => void): Promise<number>;
  /** Plays a waveform rendered at `sampleRate`; resolves when it has finished. */
  play(wave: Float32Array, sampleRate: number): Promise<void>;
  setVolume(v: number): void;
  stop(): void;
}

const CAPTURE_WORKLET = `
class Capture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) { this.port.postMessage(this.buf, [this.buf.buffer]); this.buf = new Float32Array(2048); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('resonance-capture', Capture);`;

export class MicTransport implements AirTransport {
  readonly kind = 'mic';
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private gain: GainNode | null = null;
  private volume = 1;

  async start(onSamples: (chunk: Float32Array) => void): Promise<number> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser cannot reach a microphone here. Open Resonance over https:// or on localhost.');
    }
    // Voice processing would treat our tones as noise and erase them.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    const ctx = (this.ctx = new AudioContext({ latencyHint: 'interactive' }));
    await ctx.resume();
    const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const node = new AudioWorkletNode(ctx, 'resonance-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    node.port.onmessage = (e: MessageEvent<Float32Array>) => onSamples(e.data);
    ctx.createMediaStreamSource(this.stream).connect(node);
    const sink = ctx.createGain();
    sink.gain.value = 0;
    node.connect(sink).connect(ctx.destination);
    this.gain = ctx.createGain();
    this.gain.gain.value = this.volume;
    this.gain.connect(ctx.destination);
    return ctx.sampleRate;
  }

  play(wave: Float32Array, sampleRate: number): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || !this.gain) return Promise.reject(new Error('audio is not running'));
    const buf = ctx.createBuffer(1, wave.length, sampleRate);
    buf.copyToChannel(wave as Float32Array<ArrayBuffer>, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    return new Promise((resolve) => {
      src.onended = () => resolve();
      src.start();
    });
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.gain) this.gain.gain.value = v;
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.ctx = null;
  }
}

const SIM_RATE = 48000;
const TICK_MS = 40;
const LATENCY_MS = 250;
const SPEED_OF_SOUND = 343;
const SELF_M = 0.1;
const wallMs = () => performance.timeOrigin + performance.now();

/** Loudness after `m` metres: spherical spreading plus a little air absorption (≈20 m range). */
const attenuation = (m: number) => (0.6 * Math.exp(-m / 15)) / Math.max(1, m);

export interface SimOptions {
  room?: string;
  /** Background hiss, RMS. */
  noise?: number;
  /** Where this device stands in the simulated room, in metres. */
  x?: number;
  y?: number;
}

interface Scheduled {
  wave: Float32Array;
  start: number;
  gain: number;
}

/**
 * A shared simulated room: every tab on this origin hears every other tab's transmissions
 * (through BroadcastChannel), delayed by the speed of sound and quieter with distance, mixed
 * into faint background hiss. Each tab also hears itself from 10 cm away, like a real phone.
 * Sound is placed by wall-clock timestamp a quarter second behind real time, so arrival times
 * are sample-exact and acoustic ranging works between tabs.
 */
export class SimulatedAir implements AirTransport {
  readonly kind = 'simulated';
  readonly captureDelayMs = LATENCY_MS;
  readonly x: number;
  readonly y: number;
  private channel: BroadcastChannel | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private scheduled: Scheduled[] = [];
  private volume = 1;
  private t0 = 0;
  private produced = 0;
  private readonly room: string;
  private readonly noise: number;

  constructor(opts: SimOptions = {}) {
    this.room = opts.room ?? 'resonance-air';
    this.noise = opts.noise ?? 0.01;
    this.x = opts.x ?? 0;
    this.y = opts.y ?? 0;
  }

  private indexAt(ms: number) {
    return ((ms - this.t0) / 1000) * SIM_RATE;
  }

  private schedule(wave: Float32Array, atMs: number, metres: number, gain: number) {
    const start = Math.max(this.produced, Math.round(this.indexAt(atMs) + (metres / SPEED_OF_SOUND) * SIM_RATE));
    this.scheduled.push({ wave, start, gain: gain * attenuation(metres) });
  }

  async start(onSamples: (chunk: Float32Array) => void): Promise<number> {
    this.channel = new BroadcastChannel(this.room);
    this.channel.onmessage = (e: MessageEvent<{ wave: Float32Array; gain: number; at: number; x: number; y: number }>) => {
      const m = e.data;
      this.schedule(m.wave, m.at, Math.hypot(m.x - this.x, m.y - this.y), m.gain);
    };
    this.t0 = wallMs();
    this.timer = setInterval(() => {
      const target = Math.floor(this.indexAt(wallMs() - LATENCY_MS));
      const n = Math.min(SIM_RATE, target - this.produced);
      if (n <= 0) return;
      const from = this.produced;
      const chunk = new Float32Array(n);
      for (let i = 0; i < n; i++) chunk[i] = this.noise * gaussian(Math.random);
      for (const s of this.scheduled) {
        const lo = Math.max(from, s.start);
        const hi = Math.min(from + n, s.start + s.wave.length);
        for (let i = lo; i < hi; i++) chunk[i - from] += s.gain * s.wave[i - s.start];
      }
      this.produced += n;
      this.scheduled = this.scheduled.filter((s) => s.start + s.wave.length > this.produced);
      onSamples(chunk);
    }, TICK_MS);
    return SIM_RATE;
  }

  play(wave: Float32Array, sampleRate: number): Promise<void> {
    if (sampleRate !== SIM_RATE) throw new Error('simulated air runs at 48 kHz');
    const at = wallMs();
    this.channel?.postMessage({ wave, gain: this.volume, at, x: this.x, y: this.y });
    this.schedule(wave, at, SELF_M, this.volume);
    return new Promise((r) => setTimeout(r, (wave.length / SIM_RATE) * 1000));
  }

  setVolume(v: number) {
    this.volume = v;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.channel?.close();
  }
}
