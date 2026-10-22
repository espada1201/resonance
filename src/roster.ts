import type { Body, Need, Status } from './mesh/payloads';

// The safety roster: everyone's latest check-in, the requests for help still open, and who is
// answering them. It is what a shelter desk, a stairwell or a sheriff's list needs at a glance,
// and it is built only from what this device has heard.

export type CheckInBody = Extract<Body, { kind: 'checkin' }>;
export type ReplyBody = Extract<Body, { kind: 'reply' }>;

/** Something heard on the mesh: who sent it, when it arrived here, and over how many hops. */
export interface Heard<B extends Body = Body> {
  src: number;
  msgId: number;
  at: number;
  hops: number;
  body: B;
}

export interface RosterEntry {
  /** Whom the entry is about: a device, or a person without a phone that someone checked in for. */
  key: string;
  latest: Heard<CheckInBody>;
  /** Replies to the request for help still running (help or medical since the last other status). */
  replies: Heard<ReplyBody>[];
  /** Asked for help or medical care, nobody marked it resolved, and it is under a day old. */
  open: boolean;
  /** Like open, but nothing new for over a day: shown, not counted. */
  stale: boolean;
  resolved: boolean;
  /** Someone replied "On my way". */
  coming: boolean;
}

/** A request with no news for this long stops counting as open. */
export const STALE_AFTER_SEC = 24 * 3600;
export const URGENT: Status[] = ['help', 'medical'];

const ref = (h: Pick<Heard, 'src' | 'msgId'>) => `${h.src}:${h.msgId}`;
const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
export const rosterKey = (c: Heard<CheckInBody>) => (c.body.about ? `name:${fold(c.body.about)}` : `node:${c.src}`);

/** Newest by the sender's own clock: an old "I need help" carried in from another room must not hide a newer "I'm safe". */
const newer = (a: Heard<CheckInBody>, b: Heard<CheckInBody>) => a.body.ts > b.body.ts || (a.body.ts === b.body.ts && a.at > b.at);

/**
 * One entry per person, in the order a responder works through them: open requests nobody is
 * coming to (longest waiting first), then those someone is coming to, then stale ones, sheltering,
 * resolved and safe (newest first).
 */
export function roster(checkins: Heard<CheckInBody>[], replies: Heard<ReplyBody>[], nowSec: number): RosterEntry[] {
  const byKey = new Map<string, Heard<CheckInBody>[]>();
  for (const c of checkins) byKey.set(rosterKey(c), [...(byKey.get(rosterKey(c)) ?? []), c]);
  const repliesTo = new Map<string, Heard<ReplyBody>[]>();
  for (const r of replies) repliesTo.set(ref(r.body), [...(repliesTo.get(ref(r.body)) ?? []), r]);

  const entries = [...byKey].map(([key, all]): RosterEntry => {
    const sorted = all.sort((a, b) => (newer(a, b) ? 1 : newer(b, a) ? -1 : 0));
    const latest = sorted[sorted.length - 1];
    // The request still running: the trailing run of help and medical check-ins. Replies to any of them count.
    const episode: Heard<CheckInBody>[] = [];
    for (let i = sorted.length - 1; i >= 0 && URGENT.includes(sorted[i].body.status); i--) episode.push(sorted[i]);
    const answers = episode.flatMap((c) => repliesTo.get(ref(c)) ?? []).sort((a, b) => a.body.ts - b.body.ts);
    const resolved = answers.some((r) => r.body.what === 'resolved');
    const asking = episode.length > 0 && !resolved;
    const old = nowSec - latest.body.ts > STALE_AFTER_SEC;
    return {
      key,
      latest,
      replies: answers,
      open: asking && !old,
      stale: asking && old,
      resolved,
      coming: answers.some((r) => r.body.what === 'coming'),
    };
  });
  const group = (e: RosterEntry) =>
    e.open ? (e.coming ? 1 : 0) : e.stale ? 2 : e.resolved ? 4 : e.latest.body.status === 'sheltering' ? 3 : 5;
  return entries.sort((a, b) => {
    const g = group(a) - group(b);
    if (g) return g;
    return group(a) < 2 ? a.latest.body.ts - b.latest.body.ts : b.latest.body.ts - a.latest.body.ts;
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
    const state = e.open ? 'open' : e.stale ? 'no news for a day' : e.resolved ? 'resolved' : '';
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
      e.replies.map((r) => `${text.by(r.src, r.body.nick)} ${r.body.what === 'coming' ? 'on the way' : r.body.what === 'resolved' ? 'resolved' : 'passed on'} ${iso(r.body.ts)}`).join('; '),
      b.outside ?? '',
    ].map(cell);
  });
  const head = ['Name', 'Reported by', 'Status', 'Request', 'Needs', 'Place', 'Note', 'Latitude', 'Longitude', 'Accuracy (m)', 'Sent (UTC)', 'Hops', 'Replies', 'Outside contact'];
  return [head, ...rows].map((r) => r.join(',')).join('\r\n') + '\r\n';
}
