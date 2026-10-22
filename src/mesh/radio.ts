import type { MeshClock } from './node';
import { PacketType, peekType } from './packet';

// Half-duplex channel access for an acoustic broadcast medium: listen before talk, back off
// randomly while someone else is on air, and send one frame at a time, most important first.

interface RadioIO {
  /** True while the receiver hears another transmission. */
  busy(): boolean;
  /** True while the device has suspended its audio (a locked screen, a call). */
  suspended?(): boolean;
  /** Plays one frame; resolves once it has finished on air, or with false if suspended audio cut it short. */
  send(bytes: Uint8Array): Promise<boolean>;
  /** The queue is done with a frame: it finished on air, or a full queue dropped it. */
  finished?(bytes: Uint8Array): void;
}

const SENSE_BACKOFF_MS: [number, number] = [250, 1500];
/**
 * Longest the queue defers to a busy channel: past the longest frame (20.3 s), since talking into
 * a frame loses both; but carrier sense can be fooled, and silence forever is worse.
 */
export const MAX_DEFER_MS = 25_000;
const QUEUE_LIMIT = 64;
/** Sent ahead of chat and files, own or relayed: "I need help" (and "On my way") must not wait behind a photo. */
const SAFETY_NEWS = new Set<PacketType | null>([PacketType.CheckIn, PacketType.Reply]);

interface Queued {
  bytes: Uint8Array;
  /** 0 receipts and ranging, 1 safety news, 2 everything else. */
  rank: number;
}

export class TxQueue {
  private queue: Queued[] = [];
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

  /** Queues a frame behind everything at least as important; a full queue drops the least important. */
  enqueue(bytes: Uint8Array, urgent = false) {
    const rank = urgent ? 0 : SAFETY_NEWS.has(peekType(bytes)) ? 1 : 2;
    this.insert({ bytes, rank }, this.queue.findIndex((q) => q.rank > rank));
  }

  /** Puts a frame in line before the one at `at` (-1: last); a full queue drops the least important. */
  private insert(frame: Queued, at: number) {
    this.queue.splice(at < 0 ? this.queue.length : at, 0, frame);
    for (const dropped of this.queue.splice(QUEUE_LIMIT)) this.io.finished?.(dropped.bytes);
  }

  /** Call frequently; starts the next transmission when the air is clear. */
  async tick(): Promise<void> {
    // The patience is for one unbroken stretch of busy air: any clear moment starts it afresh.
    if (!this.io.busy()) this.deferringSince = null;
    if (this.paused || this.sending || !this.queue.length || this.clock.now() < this.notBefore) return;
    // Nobody would hear it. Asking each tick costs nothing, and the frame goes the tick after audio is back.
    if (this.io.suspended?.()) return;
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
    let cutShort = false;
    try {
      cutShort = !(await this.io.send(next.bytes));
    } finally {
      this.sending = false;
      // A short random gap lets other nodes grab the channel between our frames.
      this.notBefore = this.clock.now() + 150 + this.clock.random() * 600;
      // Nobody heard it whole: it goes again first of its rank, as if it had never left the line.
      if (cutShort) this.insert(next, this.queue.findIndex((q) => q.rank >= next.rank));
      else this.io.finished?.(next.bytes);
    }
  }
}
