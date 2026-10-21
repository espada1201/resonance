import { gaussian } from '../modem/channel-sim';

/** Where sound comes from and goes to. Production uses the mic and speaker; tests and the
 *  two-tab demo use a simulated room shared between pages of the same origin. */
export interface AirTransport {
  readonly kind: 'mic' | 'simulated';
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

/**
 * A shared simulated room: every tab on this origin hears every other tab's transmissions
 * (through BroadcastChannel) mixed into a stream of faint background noise.
 */
export class SimulatedAir implements AirTransport {
  readonly kind = 'simulated';
  private channel: BroadcastChannel | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private incoming: Array<{ wave: Float32Array; pos: number }> = [];
  private volume = 1;

  constructor(
    private readonly room = 'resonance-air',
    private readonly noise = 0.01,
  ) {}

  async start(onSamples: (chunk: Float32Array) => void): Promise<number> {
    this.channel = new BroadcastChannel(this.room);
    this.channel.onmessage = (e: MessageEvent<{ wave: Float32Array; gain: number }>) =>
      this.incoming.push({ wave: e.data.wave.map((v) => v * e.data.gain * 0.6), pos: 0 });
    let last = performance.now();
    this.timer = setInterval(() => {
      const now = performance.now();
      const n = Math.min(SIM_RATE, Math.round(((now - last) / 1000) * SIM_RATE));
      last += (n / SIM_RATE) * 1000;
      if (n <= 0) return;
      const chunk = new Float32Array(n);
      for (let i = 0; i < n; i++) chunk[i] = this.noise * gaussian(Math.random);
      for (const s of this.incoming) {
        const take = Math.min(n, s.wave.length - s.pos);
        for (let i = 0; i < take; i++) chunk[i] += s.wave[s.pos + i];
        s.pos += take;
      }
      this.incoming = this.incoming.filter((s) => s.pos < s.wave.length);
      onSamples(chunk);
    }, TICK_MS);
    return SIM_RATE;
  }

  play(wave: Float32Array, sampleRate: number): Promise<void> {
    if (sampleRate !== SIM_RATE) throw new Error('simulated air runs at 48 kHz');
    this.channel?.postMessage({ wave, gain: this.volume });
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
