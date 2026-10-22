import type { MeshClock } from './node';

// Half-duplex channel access for an acoustic broadcast medium: listen before talk, back off
// randomly while someone else is on air, and send one frame at a time.

interface RadioIO {
  /** True while the receiver hears another transmission. */
  busy(): boolean;
  /** Plays one frame; resolves when it has finished on air. */
  send(bytes: Uint8Array): Promise<void>;
  /** The queue is done with a frame: it finished on air, or a full queue dropped it. */
  finished?(bytes: Uint8Array): void;
}

const SENSE_BACKOFF_MS: [number, number] = [250, 1500];
/**
 * Longest the queue defers to a busy channel: past the longest frame (20.3 s), since talking into
 * a frame loses both; but carrier sense can be fooled, and silence forever is worse.
 */
const MAX_DEFER_MS = 25_000;
const QUEUE_LIMIT = 64;

export class TxQueue {
  private queue: Uint8Array[] = [];
  private sending = false;
  private notBefore = 0;
  private deferringSince: number | null = null;
  deferrals = 0;
  /** While paused nothing new starts; a frame already on air finishes. */
  paused = false;

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
    for (const dropped of this.queue.splice(QUEUE_LIMIT)) this.io.finished?.(dropped);
  }

  /** Call frequently; starts the next transmission when the air is clear. */
  async tick(): Promise<void> {
    // The patience is for one unbroken stretch of busy air: any clear moment starts it afresh.
    if (!this.io.busy()) this.deferringSince = null;
    if (this.paused || this.sending || !this.queue.length || this.clock.now() < this.notBefore) return;
    const now = this.clock.now();
    if (this.io.busy() && now - (this.deferringSince ?? now) < MAX_DEFER_MS) {
      this.deferringSince ??= now;
      this.deferrals++;
      const [lo, hi] = SENSE_BACKOFF_MS;
      this.notBefore = now + lo + this.clock.random() * (hi - lo);
      return;
    }
    this.deferringSince = null;
    const next = this.queue.shift()!;
    this.sending = true;
    try {
      await this.io.send(next);
    } finally {
      this.sending = false;
      // A short random gap lets other nodes grab the channel between our frames.
      this.notBefore = this.clock.now() + 150 + this.clock.random() * 600;
      this.io.finished?.(next);
    }
  }
}
