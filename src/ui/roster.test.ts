import { describe, expect, it } from 'vitest';
import type { Station } from '../station';
import type { Status } from '../mesh/payloads';
import { type CheckInBody, type Heard, type ReplyBody, roster } from '../roster';
import { headcount, replyLine, replyReceipt } from './roster';

const T = 1_700_000_000;
const ME = 1;
let ids = 0;
const checkIn = (src: number, status: Status, extra: Partial<CheckInBody> = {}): Heard<CheckInBody> => ({
  src,
  msgId: ++ids,
  at: T * 1000,
  hops: 1,
  encrypted: false,
  body: { kind: 'checkin', ts: T, nick: `n${src}`, status, note: '', ...extra },
});
const coming = (to: Heard<CheckInBody>, by: number): Heard<ReplyBody> => ({
  src: by,
  msgId: ++ids,
  at: T * 1000,
  hops: 0,
  encrypted: false,
  body: { kind: 'reply', ts: T, nick: `n${by}`, what: 'coming', src: to.src, msgId: to.msgId },
});

describe('headcount', () => {
  it('says in plain words how many are asking and what is true for this device: none, not yet answered, answered by you', () => {
    const ben = checkIn(2, 'help');
    const safe = checkIn(3, 'safe');
    expect(headcount(roster([safe], [], T + 10), ME)).toBe('1 person · no one is asking for help');
    expect(headcount(roster([ben, safe], [], T + 10), ME)).toBe('2 people · 1 asking for help · 1 waiting for you');
    expect(headcount(roster([ben, safe], [coming(ben, ME)], T + 10), ME)).toBe('2 people · 1 asking for help · you are on your way to 1');
  });

  it('never reads as nobody needing you while a person still waits: your own request says you are waiting, then that someone is coming', () => {
    const own = checkIn(ME, 'help');
    expect(headcount(roster([own], [], T + 10), ME)).toBe('1 person · 1 asking for help · you are waiting for someone');
    expect(headcount(roster([own], [coming(own, 2)], T + 10), ME)).toBe('1 person · 1 asking for help · someone is coming to you');
  });

  it('adds up every kind in one line', () => {
    const own = checkIn(ME, 'help');
    const ben = checkIn(2, 'help');
    const cal = checkIn(3, 'medical');
    const dee = checkIn(4, 'help');
    const entries = roster([own, ben, cal, dee], [coming(ben, ME)], T + 10);
    expect(headcount(entries, ME)).toBe('4 people · 4 asking for help · 2 waiting for you · you are on your way to 1 · you are waiting for someone');
  });

  it('says nothing about a device when there is none to speak for, as on the beacon desk', () => {
    expect(headcount(roster([checkIn(2, 'help'), checkIn(3, 'safe')], [], T + 10))).toBe('2 people · 1 asking for help');
    expect(headcount(roster([checkIn(2, 'safe')], [], T + 10))).toBe('1 person · no one is asking for help');
  });
});

describe('the line under a request for one reply', () => {
  const ben = checkIn(2, 'help');
  const mine = { ...coming(ben, ME), at: Date.now(), msgId: 77 };
  const theirs = { ...coming(ben, 3), at: Date.now() };
  const station = (queued: boolean, passed: boolean) => ({ id: ME, queued: () => queued, journal: { wasPassedOn: (id: number) => passed && id === 77 } }) as unknown as Station;
  const by = (_src: number, nick: string) => nick;

  it('says "waiting to send…" while our reply has not been on air, whatever else is known', () => {
    expect(replyReceipt(station(true, false), mine)).toBe('waiting to send…');
    expect(replyReceipt(station(true, true), mine)).toBe('waiting to send…');
  });

  it('says whether another phone has our reply once it has gone, and says nothing about anyone else\'s', () => {
    expect(replyReceipt(station(false, false), mine)).toBe('sent, not heard by another phone yet');
    expect(replyReceipt(station(false, true), mine)).toBe('heard by a phone nearby');
    expect(replyReceipt(station(true, true), theirs)).toBe('');
  });

  it('is who, how long ago and the receipt, in one line', () => {
    expect(replyLine(station(false, true), mine, by)).toBe('You are on the way · just now · heard by a phone nearby');
    expect(replyLine(station(false, true), theirs, by)).toBe('n3 is on the way · just now');
  });
});
