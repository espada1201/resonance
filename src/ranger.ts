import { type Packet, PacketType, encodePacket, randomU32 } from './mesh/packet';
import { type Body, encodeBody } from './mesh/payloads';
import { twoWayDistance } from './mesh/ranging';
import { renderPing } from './modem/ping';
import type { DecodedFrame } from './modem/receiver';

// Find mode: repeated two-way acoustic ranging with one chosen device, like an avalanche
// transceiver. Each round: we send a range request frame with our ping 0.2 s behind it; the
// target notes when our ping reached it, answers with its own ping, then reports the interval
// it measured. Both intervals are measured on each device's own sample clock.

type RangeBody = Extract<Body, { kind: 'range' }>;

interface RangerIO {
  readonly id: number;
  sampleRate(): number;
  modulate(bytes: Uint8Array): Float32Array;
  /** Plays audio as soon as the air is free, holding back the normal transmit queue. */
  playExclusive(wave: Float32Array, label: string): Promise<void>;
  /** Queues a frame ahead of everything else. */
  sendUrgent(bytes: Uint8Array): void;
  changed(): void;
}

interface FindState {
  target: number;
  phase: 'pinging' | 'waiting' | 'resting';
  /** Distances in metres, oldest first. */
  readings: number[];
  note: string;
}

interface HeardPing {
  pos: number;
  rho: number;
  at: number;
}

const GAP_SEC = 0.2;
const REPLY_TIMEOUT_MS = 9000;
const REST_MS = 1200;
/** Output latency + capture batching + matched-filter block latency, with margin. */
const DETECT_MS = 700;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Ranger {
  find: FindState | null = null;
  /** Answer other devices' range requests. */
  answering = true;
  private pings: HeardPing[] = [];
  private waiter: { session: number; resolve: (r: { intervalUs: number; frameStart: number } | null) => void } | null = null;
  private generation = 0;

  constructor(private readonly io: RangerIO) {}

  onPing(pos: number, rho: number) {
    this.pings = [...this.pings.slice(-60), { pos, rho, at: Date.now() }];
  }

  start(target: number) {
    this.stop();
    this.find = { target, phase: 'pinging', readings: [], note: 'Pinging…' };
    void this.loop(++this.generation);
    this.io.changed();
  }

  stop() {
    this.generation++;
    this.find = null;
    this.waiter?.resolve(null);
    this.waiter = null;
    this.io.changed();
  }

  private packet(dst: number, body: RangeBody) {
    const p: Packet = {
      type: PacketType.Range,
      encrypted: false,
      ackRequested: false,
      msgId: randomU32(),
      src: this.io.id,
      dst,
      ttl: 1,
      hops: 0,
      attempt: 0,
      channel: 0,
      body: encodeBody(body),
    };
    return encodePacket(p);
  }

  /** The loudest ping heard (by arrival on this thread) since wall-clock time t0. */
  private loudestSince(t0: number) {
    return this.pings.filter((p) => p.at >= t0).sort((a, b) => b.rho - a.rho)[0] ?? null;
  }

  /** The loudest ping whose sample position falls in [lo, hi]. */
  private loudestBetween(lo: number, hi: number) {
    return this.pings.filter((p) => p.pos >= lo && p.pos <= hi).sort((a, b) => b.rho - a.rho)[0] ?? null;
  }

  private async loop(gen: number) {
    const live = () => gen === this.generation && this.find;
    while (live()) {
      const f = this.find!;
      const fs = this.io.sampleRate();
      const session = randomU32() & 0xffff;
      f.phase = 'pinging';
      this.io.changed();

      const frame = this.io.modulate(this.packet(f.target, { kind: 'range', phase: 'request', session, intervalUs: 0 }));
      const ping = renderPing(fs);
      const wave = new Float32Array(frame.length + Math.round((GAP_SEC + 0.05) * fs) + ping.length);
      wave.set(frame);
      wave.set(ping, frame.length + Math.round(GAP_SEC * fs));
      const reply = new Promise<{ intervalUs: number; frameStart: number } | null>((resolve) => {
        this.waiter = { session, resolve };
        setTimeout(() => resolve(null), REPLY_TIMEOUT_MS + wave.length / fs * 1000);
      });
      const t0 = Date.now();
      await this.io.playExclusive(wave, 'range request + ping');
      await sleep(DETECT_MS);
      if (!live()) return;
      const own = this.loudestSince(t0);
      f.phase = 'waiting';
      f.note = own ? 'Listening for their answer…' : 'This device did not hear its own ping. Turn the volume up.';
      this.io.changed();
      const r = await reply;
      this.waiter = null;
      if (!live()) return;
      if (!own || !r) {
        if (own) f.note = 'No answer. Are they listening, in earshot, and answering distance requests?';
      } else {
        const theirs = this.loudestBetween(own.pos + 0.25 * fs, r.frameStart - 0.02 * fs);
        if (!theirs) {
          f.note = 'Heard their report but missed their ping. Trying again.';
        } else {
          const meters = twoWayDistance((theirs.pos - own.pos) / fs, r.intervalUs / 1e6);
          f.readings = [...f.readings.slice(-29), Math.max(0, meters)];
          f.note = '';
        }
      }
      f.phase = 'resting';
      this.io.changed();
      await sleep(REST_MS);
    }
  }

  /** Handles a range packet addressed to this device, decoded from `frame`. */
  async onPacket(p: Packet, body: RangeBody, frame: DecodedFrame | null) {
    if (p.dst !== this.io.id) return;
    if (body.phase === 'report') {
      if (this.waiter?.session === body.session && frame) this.waiter.resolve({ intervalUs: body.intervalUs, frameStart: frame.startSample });
      return;
    }
    if (!this.answering || !frame) return;
    const fs = this.io.sampleRate();
    const frameEnd = frame.startSample + frame.airtimeSec * fs;
    // Their ping trails the request by GAP_SEC; give the detector time to report it.
    await sleep(DETECT_MS + GAP_SEC * 1000);
    const theirs = this.loudestBetween(frameEnd + 0.05 * fs, frameEnd + (GAP_SEC + 0.4) * fs);
    if (!theirs) return;
    const wave = new Float32Array(Math.round(0.1 * fs) + Math.ceil(0.04 * fs));
    wave.set(renderPing(fs));
    const t0 = Date.now();
    await this.io.playExclusive(wave, 'range answer ping');
    await sleep(DETECT_MS);
    const mine = this.loudestSince(t0);
    if (!mine) return;
    const intervalUs = Math.round(((mine.pos - theirs.pos) / fs) * 1e6);
    if (intervalUs <= 0) return;
    this.io.sendUrgent(this.packet(p.src, { kind: 'range', phase: 'report', session: body.session, intervalUs }));
  }
}
