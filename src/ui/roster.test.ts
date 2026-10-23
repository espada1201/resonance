import { describe, expect, it } from 'vitest';
import type { Status } from '../mesh/payloads';
import { type CheckInBody, type Heard, type ReplyBody, roster } from '../roster';
import { headcount } from './roster';

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
