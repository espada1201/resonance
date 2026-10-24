import type { Body, Need, Status } from './mesh/payloads';

// The safety roster: everyone's latest check-in, the requests for help still open, and who is
// answering them. It is what a shelter desk, a stairwell or a sheriff's list needs at a glance,
// and it is built only from what this device has heard.

export type CheckInBody = Extract<Body, { kind: 'checkin' }>;
export type ReplyBody = Extract<Body, { kind: 'reply' }>;

/** Something heard on the mesh (or sent from here): who sent it, when it arrived here, and over how many hops. */
export interface Heard<B extends Body = Body> {
  src: number;
  msgId: number;
  at: number;
  hops: number;
  /** Sealed for a circle. A reply to it is sealed too, and one to an open check-in is not. */
  encrypted: boolean;
  body: B;
}

export type NoticeBody = Extract<Body, { kind: 'notice' }>;

/**
 * When the sender says it was sent, but no later than it arrived here: a date from the future would
 * outrank everything for good. Orders one sender's own news: its clock may be off, but by the same for all of it.
 */
export const sentAt = (h: Heard<CheckInBody | ReplyBody | NoticeBody>) => Math.min(h.body.ts, Math.floor(h.at / 1000));

/**
 * When it was most likely written, in ms, to say how long ago and to compare different senders.
 * Heard from its author itself, just now: that phone's clock may be years off. Passed along, it may
 * have travelled for hours, so go by the author's clock, but never later than it arrived.
 */
export const writtenAt = (h: { at: number; hops: number; body?: { ts: number } }) => (h.body && h.hops > 0 ? Math.min(h.at, h.body.ts * 1000) : h.at);
const writtenSec = (h: Heard<CheckInBody>) => Math.floor(writtenAt(h) / 1000);

/** Lasting news is kept this long, as long as the mesh carries it. */
const KEEP_MS = 72 * 3600_000;
/** Most of each kind kept: a big shelter's worth, small enough for the browser's storage. */
const KEEP_MOST = 600;

/**
 * Check-ins, replies and notices heard or sent, kept apart from the chat feed (which keeps only the
 * newest few hundred items of everything) for as long as the mesh carries them.
 */
export class SafetyLog {
  checkins: Heard<CheckInBody>[] = [];
  replies: Heard<ReplyBody>[] = [];
  notices: Heard<NoticeBody>[] = [];

  /** Adds safety news (anything else is ignored); false if it was already here. */
  add(h: Heard): boolean {
    const list = this.listFor(h.body);
    if (!list || list.some((x) => x.src === h.src && x.msgId === h.msgId)) return false;
    list.push(h);
    return true;
  }

  /** Forgets what is older than the mesh keeps, then the oldest of anything over the limit. */
  prune(nowMs: number) {
    const keep = <B extends Body>(list: Heard<B>[]) => list.filter((h) => nowMs - h.at <= KEEP_MS).slice(-KEEP_MOST);
    this.checkins = keep(this.checkins);
    this.replies = keep(this.replies);
    this.notices = keep(this.notices);
  }

  snapshot() {
    return { checkins: this.checkins, replies: this.replies, notices: this.notices };
  }

  restore(s: Partial<SafetySnapshot>) {
    this.checkins = s.checkins ?? [];
    this.replies = s.replies ?? [];
    this.notices = s.notices ?? [];
  }

  private listFor(b: Body): Heard[] | null {
    if (b.kind === 'checkin') return this.checkins;
    if (b.kind === 'reply') return this.replies;
    if (b.kind === 'notice') return this.notices;
    return null;
  }
}

/** The safety log as saved. */
export type SafetySnapshot = ReturnType<SafetyLog['snapshot']>;

export interface RosterEntry {
  /** Whom the entry is about: a device, or a person without a phone that someone checked in for. */
  key: string;
  latest: Heard<CheckInBody>;
  /** Replies to the asks still open or, once all are resolved, to every help and medical check-in since the last other status. */
  replies: Heard<ReplyBody>[];
  /** Asked for help or medical care, nobody marked that ask resolved, and it is under a day old. */
  open: boolean;
  /** Like open, but nothing new for over a day: shown, not counted. */
  stale: boolean;
  resolved: boolean;
  /** Resolved because the sender took the request back as a mistake, not because help came. */
  cancelled: boolean;
  /** Someone replied "On my way". */
  coming: boolean;
}

/** A request with no news for this long stops counting as open. */
export const STALE_AFTER_SEC = 24 * 3600;
export const URGENT: Status[] = ['help', 'medical'];

/**
 * The open requests this device still has to act on: not its own call for help (one it made for
 * someone without a phone is still someone's), and not one it has answered "On my way".
 */
export const needingYou = (entries: RosterEntry[], self: number) =>
  entries.filter((e) => e.open && !(e.latest.src === self && !e.latest.body.about) && !e.replies.some((r) => r.src === self && r.body.what === 'coming'));

/** A "resolved" from the request's own sender with the mistake flag: a take-back. Anyone else's flag is only a resolved. */
export const tookBack = (r: Heard<ReplyBody>) => r.body.what === 'resolved' && !!r.body.mistake && r.src === r.body.src;

const ref = (h: Pick<Heard, 'src' | 'msgId'>) => `${h.src}:${h.msgId}`;
export const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
export const rosterKey = (c: Heard<CheckInBody>) => (c.body.about ? `name:${c.src}:${fold(c.body.about)}` : `node:${c.src}`);

/** Newest by the sender's own clock: an old "I need help" carried in from another room must not hide a newer "I'm safe". */
const newer = (a: Heard<CheckInBody>, b: Heard<CheckInBody>) => sentAt(a) > sentAt(b) || (sentAt(a) === sentAt(b) && a.at > b.at);

/** Check-ins whose place in the roster a newer one from the same device about the same person has taken. */
export function superseded(checkins: Heard<CheckInBody>[]): Heard<CheckInBody>[] {
  const latest = new Map<string, Heard<CheckInBody>>();
  for (const c of checkins) {
    const prev = latest.get(rosterKey(c));
    if (!prev || newer(c, prev)) latest.set(rosterKey(c), c);
  }
  return checkins.filter((c) => newer(latest.get(rosterKey(c))!, c));
}

/**
 * One entry per person (and per reporter, for someone checked in by others), in the order a
 * responder works through them: open requests nobody is coming to (longest waiting first), then
 * those someone is coming to, then stale ones, sheltering, resolved and safe (newest first).
 */
export function roster(checkins: Heard<CheckInBody>[], replies: Heard<ReplyBody>[], nowSec: number): RosterEntry[] {
  const byKey = new Map<string, Heard<CheckInBody>[]>();
  for (const c of checkins) byKey.set(rosterKey(c), [...(byKey.get(rosterKey(c)) ?? []), c]);
  const repliesTo = new Map<string, Heard<ReplyBody>[]>();
  for (const r of replies) repliesTo.set(ref(r.body), [...(repliesTo.get(ref(r.body)) ?? []), r]);

  const answersTo = (c: Heard<CheckInBody>) => repliesTo.get(ref(c)) ?? [];
  const askedAt = new Map<string, number>();
  const entries = [...byKey].map(([key, all]): RosterEntry => {
    const sorted = all.sort((a, b) => (newer(a, b) ? 1 : newer(b, a) ? -1 : 0));
    const latest = sorted[sorted.length - 1];
    // The trailing run of help and medical check-ins. A Resolved answers the ask it replies to and
    // the ones before: whoever sent it had heard those, whatever the clocks say. Later asks stay open.
    let first = sorted.length;
    while (first > 0 && URGENT.includes(sorted[first - 1].body.status)) first--;
    const run = sorted.slice(first);
    let closed = -1;
    run.forEach((c, i) => answersTo(c).some((r) => r.body.what === 'resolved') && (closed = i));
    const asks = run.slice(closed + 1);
    // What closed the request last decides how it ended: a take-back, or help that came.
    const closer = closed >= 0 ? answersTo(run[closed]).filter((r) => r.body.what === 'resolved').sort((a, b) => writtenAt(a) - writtenAt(b)).at(-1) : undefined;
    askedAt.set(key, writtenSec(asks[0] ?? latest));
    const answers = (asks.length ? asks : run).flatMap(answersTo).sort((a, b) => writtenAt(a) - writtenAt(b));
    const old = nowSec - writtenSec(latest) > STALE_AFTER_SEC;
    return {
      key,
      latest,
      replies: answers,
      open: asks.length > 0 && !old,
      stale: asks.length > 0 && old,
      resolved: run.length > 0 && asks.length === 0,
      cancelled: run.length > 0 && asks.length === 0 && !!closer && tookBack(closer),
      coming: answers.some((r) => r.body.what === 'coming'),
    };
  });
  const group = (e: RosterEntry) =>
    e.open ? (e.coming ? 1 : 0) : e.stale ? 2 : e.resolved ? 4 : e.latest.body.status === 'sheltering' ? 3 : 5;
  return entries.sort((a, b) => {
    const g = group(a) - group(b);
    if (g) return g;
    return group(a) < 2 ? askedAt.get(a.key)! - askedAt.get(b.key)! : writtenAt(b.latest) - writtenAt(a.latest);
  });
}

/** Entries whose name, place, note or needs contain the query (ignoring case and accents). */
export function search(entries: RosterEntry[], query: string, name: (e: RosterEntry) => string, needText: Record<Need, string>): RosterEntry[] {
  const q = fold(query);
  if (!q) return entries;
  return entries.filter((e) => {
    const b = e.latest.body;
    return fold([name(e), b.place ?? '', b.note, ...(b.needs ?? []).map((n) => needText[n])].join(' ')).includes(q);
  });
}

/**
 * The roster as CSV for a responder's spreadsheet. Text from the air is untrusted, so cells that a
 * spreadsheet would run as a formula start with an apostrophe.
 */
export function rosterCsv(
  entries: RosterEntry[],
  text: { name: (e: RosterEntry) => string; by: (src: number, nick: string) => string; status: Record<Status, string>; need: Record<Need, string> },
): string {
  const cell = (v: string | number) => {
    if (typeof v === 'number') return String(v);
    const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const iso = (sec: number) => new Date(sec * 1000).toISOString();
  const rows = entries.map((e) => {
    const { body: b, src, hops } = e.latest;
    const state = e.open ? 'open' : e.stale ? 'no news for a day' : e.cancelled ? 'cancelled (sent by mistake)' : e.resolved ? 'resolved' : '';
    return [
      text.name(e),
      b.about ? text.by(src, b.nick) : '',
      text.status[b.status],
      state,
      (b.needs ?? []).map((n) => text.need[n]).join('; '),
      b.place ?? '',
      b.note,
      b.geo ? +b.geo.lat.toFixed(5) : '',
      b.geo ? +b.geo.lon.toFixed(5) : '',
      b.geo ? Math.round(b.geo.accuracyM) : '',
      iso(b.ts),
      hops,
      e.replies.map((r) => `${text.by(r.src, r.body.nick)} ${r.body.what === 'coming' ? 'on the way' : r.body.what === 'resolved' ? (tookBack(r) ? 'took it back' : 'resolved') : 'passed on'} ${iso(r.body.ts)}`).join('; '),
      b.outside ?? '',
    ].map(cell);
  });
  const head = ['Name', 'Reported by', 'Status', 'Request', 'Needs', 'Place', 'Note', 'Latitude', 'Longitude', 'Accuracy (m)', 'Sent (UTC)', 'Hops', 'Replies', 'Outside contact'];
  return [head, ...rows].map((r) => r.join(',')).join('\r\n') + '\r\n';
}
