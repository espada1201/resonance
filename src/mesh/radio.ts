import type { MeshClock } from './node';

// Half-duplex channel access for an acoustic broadcast medium: listen before talk, back off
// randomly while someone else is on air, and send one frame at a time.

export interface RadioIO {
  /** True while the receiver hears a frame or a preamble. */
  busy(): boolean;
  /** Plays one frame; resolves when it has finished on air. */
  send(bytes: Uint8Array): Promise<void>;
}

const SENSE_BACKOFF_MS: [number, number] = [250, 1500];
const QUEUE_LIMIT = 64;

export class TxQueue {
  private queue: Uint8Array[] = [];
  private sending = false;
  private notBefore = 0;
  sent = 0;
  deferrals = 0;

  constructor(
    private readonly io: RadioIO,
    private readonly clock: MeshClock,
  ) {}

  get length() {
    return this.queue.length + (this.sending ? 1 : 0);
  }

  get onAir() {
    return this.sending;
  }

  enqueue(bytes: Uint8Array, urgent = false) {
    if (urgent) this.queue.unshift(bytes);
    else this.queue.push(bytes);
    if (this.queue.length > QUEUE_LIMIT) this.queue.length = QUEUE_LIMIT;
  }

  clear() {
    this.queue = [];
  }

  /** Call frequently; starts the next transmission when the air is clear. */
  async tick(): Promise<void> {
    if (this.sending || !this.queue.length || this.clock.now() < this.notBefore) return;
    if (this.io.busy()) {
      this.deferrals++;
      const [lo, hi] = SENSE_BACKOFF_MS;
      this.notBefore = this.clock.now() + lo + this.clock.random() * (hi - lo);
      return;
    }
    const next = this.queue.shift()!;
    this.sending = true;
    try {
      await this.io.send(next);
      this.sent++;
    } finally {
      this.sending = false;
      // A short random gap lets other nodes grab the channel between our frames.
      this.notBefore = this.clock.now() + 150 + this.clock.random() * 600;
    }
  }
}
