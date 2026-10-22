import { type Parcel, parcels } from './courier';
import { BROADCAST } from './mesh/packet';
import { type ContentBody, isContent } from './mesh/payloads';
import { activeNotices } from './notices';
import { type Heard, type NoticeBody, type ReplyBody, type RosterEntry, SafetyLog, type SafetySnapshot, roster, writtenAt } from './roster';

// Everything said on the mesh that this device knows, heard or sent: the feed people read, and the
// safety log responders act on. The station hands it what it opened (or could not open); the
// journal decides where that goes, keeps it, and answers the screens' questions.

/** What people say: everything the feed shows, plus replies, which show under their check-in. */
export type Said = ContentBody | ReplyBody;

/** How one packet met this device. A feed item is one, so a locked item opens with its own time and hops. */
export type Meta = Omit<Heard, 'body'> & { dst: number };

export interface FeedItem extends Meta {
  /** `src:msgId`, or `file:<key>`. */
  id: string;
  mine: boolean;
  /** Sealed for a circle whose passphrase we do not have. */
  locked: boolean;
  body?: ContentBody;
  fileKey?: string;
  /** For direct messages. 'unknown': the app was closed while waiting for the receipt. */
  delivery?: 'sending' | 'acked' | 'failed' | 'unknown';
  /** For our own broadcasts: another device was heard repeating it. */
  passedOn?: boolean;
}

const FEED_KEPT = 400;
const FEED_SAVED = 200;

export class Journal {
  /** Newest first. */
  feed: FeedItem[] = [];
  private log = new SafetyLog();

  constructor(
    private readonly self: number,
    private readonly clock: { now(): number },
  ) {}

  /**
   * A packet said something (heard, sent from here, or opened late), or it is sealed for a circle we
   * are not in. Safe to repeat: nothing is kept twice, and a locked item that opens keeps its place.
   */
  add(meta: Meta, body: Said | 'locked') {
    // Picked, not spread: a feed item passed in as its own arrival record would bring its feed state along.
    const { src, msgId, at, hops, encrypted, dst } = meta;
    if (body !== 'locked') this.addToLog(meta, body);
    const id = `${src}:${msgId}`;
    const i = this.feed.findIndex((x) => x.id === id);
    if (i >= 0 && !(this.feed[i].locked && body !== 'locked')) return;
    const mine = src === this.self;
    const base = { id, src, msgId, at, hops, mine, encrypted };
    let item: FeedItem | null = null;
    if (body === 'locked') item = { ...base, locked: true, dst };
    else if (isContent(body)) item = { ...base, locked: false, dst, body, delivery: mine && dst !== BROADCAST ? 'sending' : undefined };
    if (i >= 0) {
      // Opened in place; a reply is never an item, so an opened one leaves.
      if (item) this.feed[i] = item;
      else this.feed.splice(i, 1);
    } else if (item) this.feed = [item, ...this.feed].slice(0, FEED_KEPT);
  }

  /** Safety news for the log alone: opened after the feed let its locked item go, it must not come back at the top of the feed. */
  addToLog(meta: Meta, body: Said) {
    const { src, msgId, at, hops, encrypted } = meta;
    if (this.log.add({ src, msgId, at, hops, encrypted, body })) this.log.prune(this.clock.now());
  }

  /** A file's item, the first time we meet any chunk of it (or send it). */
  file(meta: Meta, key: string) {
    const id = `file:${key}`;
    if (this.feed.some((x) => x.id === id)) return;
    const { src, msgId, at, hops, encrypted, dst } = meta;
    this.feed = [{ id, src, msgId, at, hops, mine: src === this.self, encrypted, locked: false, dst, fileKey: key }, ...this.feed].slice(0, FEED_KEPT);
  }

  /** A receipt came back for our direct message, or it gave up after its retries. */
  delivered(msgId: number, ok: boolean) {
    const item = this.feed.find((i) => i.mine && i.msgId === msgId);
    if (item) item.delivery = ok ? 'acked' : 'failed';
  }

  /** Another device repeated a broadcast of ours. */
  passedOn(msgId: number) {
    const item = this.feed.find((i) => i.mine && i.msgId === msgId && i.dst === BROADCAST);
    if (item) item.passedOn = true;
  }

  /** Removes an item (one sent again took its place). */
  drop(id: string) {
    this.feed = this.feed.filter((i) => i.id !== id);
  }

  /** Everyone's latest check-in, in the order a responder works through them. */
  roster(): RosterEntry[] {
    return roster(this.log.checkins, this.log.replies, Math.floor(this.clock.now() / 1000));
  }

  /** Check-ins naming someone outside, newest first, marked once someone passed them on. */
  parcels(): Parcel[] {
    return parcels(this.log.checkins, this.log.replies);
  }

  /** The notices still running, danger first. */
  notices(): Heard<NoticeBody>[] {
    return activeNotices(this.log.notices, Math.floor(this.clock.now() / 1000));
  }

  /** The replies to one check-in, oldest first. */
  repliesTo(src: number, msgId: number): Heard<ReplyBody>[] {
    return this.log.replies.filter((r) => r.body.src === src && r.body.msgId === msgId).sort((a, b) => writtenAt(a) - writtenAt(b));
  }

  snapshot(): { safety: SafetySnapshot; feed: FeedItem[] } {
    return { safety: this.log.snapshot(), feed: this.feed.slice(0, FEED_SAVED) };
  }

  restore(saved: { safety: SafetySnapshot | null; feed: FeedItem[] | null; resent: Set<string> }) {
    const retriesLost = (i: FeedItem) => i.delivery === 'sending' && !saved.resent.has(i.id);
    this.feed = (saved.feed ?? []).map((i) => (retriesLost(i) ? { ...i, delivery: 'unknown' } : i));
    this.log = new SafetyLog();
    if (saved.safety) this.log.restore(saved.safety);
    else this.rebuildLogFromFeed();
    this.log.prune(this.clock.now());
  }

  private rebuildLogFromFeed() {
    for (const { src, msgId, at, hops, encrypted, body } of [...this.feed].reverse()) if (body) this.log.add({ src, msgId, at, hops, encrypted, body });
  }

  /** "Clear everything heard". */
  clear() {
    this.feed = [];
    this.log = new SafetyLog();
  }
}
