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
  it('counts people and open requests, and says how many of them are for this device', () => {
    const own = checkIn(ME, 'help');
    const ben = checkIn(2, 'help');
    const cal = checkIn(3, 'medical');
    const entries = roster([own, ben, cal], [coming(ben, ME)], T + 10);
    expect(headcount(entries)).toBe('3 people · 3 open requests');
    expect(headcount(entries, ME)).toBe('3 people · 3 open requests (1 for you)');
  });

  it('says none are for you when the only open request is your own, so it never contradicts the Safety count', () => {
    const entries = roster([checkIn(ME, 'help')], [], T + 10);
    expect(headcount(entries, ME)).toBe('1 person · 1 open request (none for you)');
  });

  it('adds nothing when every open request is for you, or none is open', () => {
    expect(headcount(roster([checkIn(2, 'help')], [], T + 10), ME)).toBe('1 person · 1 open request');
    expect(headcount(roster([checkIn(2, 'safe')], [], T + 10), ME)).toBe('1 person · 0 open requests');
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
    expect(replyReceipt(station(false, false), mine)).toBe('sent, no other phone has passed it on yet');
    expect(replyReceipt(station(false, true), mine)).toBe('another phone has it');
    expect(replyReceipt(station(true, true), theirs)).toBe('');
  });

  it('is who, how long ago and the receipt, in one line', () => {
    expect(replyLine(station(false, true), mine, by)).toBe('You are on the way · just now · another phone has it');
    expect(replyLine(station(false, true), theirs, by)).toBe('n3 is on the way · just now');
  });
});
