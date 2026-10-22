import { beforeEach, describe, expect, it } from 'vitest';
import { type FeedItem, Journal, type Meta } from './journal';
import { BROADCAST } from './mesh/packet';
import type { ContentBody } from './mesh/payloads';
import type { CheckInBody, NoticeBody, ReplyBody } from './roster';

const ME = 0x0a0a0a;
const BEN = 0x2b2b2b;
const CAL = 0x3c3c3c;
const T = Date.parse('2026-10-22T09:00:00Z');
const TS = T / 1000;

let now = T;
const clock = { now: () => now };
let j: Journal;
beforeEach(() => {
  now = T;
  j = new Journal(ME, clock);
});

const met = (src: number, msgId: number, extra: Partial<Meta> = {}): Meta => ({ src, msgId, at: now, hops: 0, encrypted: false, dst: BROADCAST, ...extra });
const text = (t: string, nick = 'Ben'): ContentBody => ({ kind: 'text', ts: TS, nick, text: t });
const help: CheckInBody = { kind: 'checkin', ts: TS, nick: 'Cal', status: 'help', note: 'Twisted ankle' };
const answer = (what: ReplyBody['what'], ts = TS): ReplyBody => ({ kind: 'reply', ts, nick: 'Ben', what, src: CAL, msgId: 2 });
const ids = () => j.feed.map((i) => i.id);

describe('journal', () => {
  it('keeps each packet once, newest first: what people read in the feed, safety news in the log', () => {
    j.add(met(BEN, 1), text('Water at the north stairwell'));
    j.add(met(CAL, 2, { hops: 1 }), help);
    j.add(met(CAL, 2, { hops: 3, at: T + 5000 }), help);
    j.file(met(BEN, 500), `${BEN}:77`);
    j.file(met(BEN, 501), `${BEN}:77`);
    expect(ids()).toEqual([`file:${BEN}:77`, `${CAL}:2`, `${BEN}:1`]);
    expect(j.feed[1]).toEqual({ id: `${CAL}:2`, src: CAL, msgId: 2, at: T, hops: 1, mine: false, encrypted: false, locked: false, dst: BROADCAST, body: help });
    expect(j.roster().map((e) => e.latest)).toEqual([{ src: CAL, msgId: 2, at: T, hops: 1, encrypted: false, body: help }]);
  });

  it('shows a reply under its check-in, oldest first, never as an item of its own', () => {
    j.add(met(CAL, 2), help);
    j.add(met(BEN, 4), answer('resolved', TS + 60));
    j.add(met(BEN, 3), answer('coming'));
    expect(ids()).toEqual([`${CAL}:2`]);
    expect(j.repliesTo(CAL, 2).map((r) => r.body.what)).toEqual(['coming', 'resolved']);
    expect(j.roster()[0]).toMatchObject({ open: false, resolved: true, coming: true });
  });

  it('opens a locked item where it lies, as it first arrived; an opened reply leaves the feed', () => {
    j.add(met(CAL, 2, { encrypted: true, hops: 2 }), 'locked');
    j.add(met(BEN, 3, { encrypted: true }), 'locked');
    now += 60_000;
    j.add(met(BEN, 1), text('Meet at six'));
    // As joining the circle does: each locked item is its own arrival record.
    const [, reply, checkIn] = j.feed;
    j.add(checkIn, help);
    j.add(reply, answer('coming'));
    j.add(checkIn, help);
    expect(j.feed.map((i) => [i.id, i.locked])).toEqual([
      [`${BEN}:1`, false],
      [`${CAL}:2`, false],
    ]);
    expect(j.feed[1]).toEqual({ id: `${CAL}:2`, src: CAL, msgId: 2, at: T, hops: 2, mine: false, encrypted: true, locked: false, dst: BROADCAST, body: help });
    const [cal] = j.roster();
    expect(cal.latest).toEqual({ src: CAL, msgId: 2, at: T, hops: 2, encrypted: true, body: help });
    expect(cal.coming).toBe(true);
  });

  it('follows a direct message of ours to its receipt, and drops one sent again', () => {
    j.add(met(ME, 7, { dst: BEN }), text('Are you hurt?', 'Ana'));
    j.add(met(ME, 8), text('Meet at six', 'Ana'));
    expect(j.feed.map((i) => [i.mine, i.delivery])).toEqual([
      [true, undefined],
      [true, 'sending'],
    ]);
    j.delivered(7, false);
    expect(j.feed[1].delivery).toBe('failed');
    j.delivered(7, true);
    expect(j.feed[1].delivery).toBe('acked');
    j.drop(`${ME}:7`);
    expect(ids()).toEqual([`${ME}:8`]);
  });

  it('keeps the newest 400 items and saves 200, while the log keeps what responders need', () => {
    j.add(met(CAL, 2), help);
    for (let i = 0; i < 450; i++) j.add(met(BEN, 100 + i), text(`chat ${i}`));
    expect(j.feed).toHaveLength(400);
    expect(j.snapshot().feed).toEqual(j.feed.slice(0, 200));
    expect(j.roster().map((e) => e.latest.msgId)).toEqual([2]);
  });

  it('comes back after a reload; a receipt still awaited is unknown, as its retries died with the page', () => {
    j.add(met(CAL, 2, { hops: 1 }), help);
    j.add(met(BEN, 3), answer('coming'));
    j.add(met(ME, 7, { dst: CAL }), text('On my way', 'Ana'));
    const reloaded = new Journal(ME, clock);
    reloaded.restore(JSON.parse(JSON.stringify(j.snapshot())));
    expect(reloaded.feed).toEqual([{ ...j.feed[0], delivery: 'unknown' }, j.feed[1]]);
    expect(reloaded.roster()).toEqual(j.roster());
  });

  it('seeds the log from the feed of a save made before it existed', () => {
    const notice: NoticeBody = { kind: 'notice', ts: TS, nick: 'Desk', topic: 'water', hours: 12, place: 'Gym', text: 'Drinking water' };
    const old: FeedItem[] = [
      { id: `${BEN}:5`, src: BEN, msgId: 5, at: T, hops: 0, mine: false, encrypted: false, locked: false, dst: BROADCAST, body: notice },
      { id: `${BEN}:1`, src: BEN, msgId: 1, at: T, hops: 0, mine: false, encrypted: false, locked: false, dst: BROADCAST, body: text('Hi') },
      { id: `${CAL}:2`, src: CAL, msgId: 2, at: T, hops: 1, mine: false, encrypted: true, locked: false, dst: BROADCAST, body: help },
    ];
    j.restore({ safety: null, feed: old });
    expect(j.feed).toEqual(old);
    expect(j.roster().map((e) => e.latest)).toEqual([{ src: CAL, msgId: 2, at: T, hops: 1, encrypted: true, body: help }]);
    expect(j.notices().map((n) => n.body)).toEqual([notice]);
  });

  it('forgets everything heard when asked', () => {
    j.add(met(CAL, 2), help);
    j.add(met(BEN, 1), text('Hi'));
    j.clear();
    expect(j.feed).toEqual([]);
    expect(j.roster()).toEqual([]);
    expect(j.snapshot()).toEqual({ safety: { checkins: [], replies: [], notices: [] }, feed: [] });
  });
});
