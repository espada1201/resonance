import { describe, expect, it } from 'vitest';
import type { Topic } from './mesh/payloads';
import { activeNotices } from './notices';
import type { Heard, NoticeBody } from './roster';

const T = 1_700_000_000;
let ids = 0;
const notice = (src: number, topic: Topic, ts: number, hours: number, place = 'Gym'): Heard<NoticeBody> => ({
  src,
  msgId: ++ids,
  at: ts * 1000,
  hops: 1,
  encrypted: false,
  body: { kind: 'notice', ts, nick: `n${src}`, topic, hours, place, text: `${topic} at ${place}` },
});

describe('notices', () => {
  it('shows notices until they run out, danger first, then newest, one per author, topic and place', () => {
    const water = notice(1, 'water', T, 3);
    const waterUpdate = notice(1, 'water', T + 600, 12, ' gym ');
    const otherPlace = notice(1, 'water', T + 700, 12, 'Church');
    const expired = notice(2, 'food', T - 4 * 3600, 3);
    const danger = notice(3, 'danger', T - 3600, 24, 'Bridge');
    const info = notice(4, 'info', T + 900, 72);
    const got = activeNotices([water, expired, danger, waterUpdate, info, otherPlace], T + 1000);
    expect(got).toEqual([danger, info, otherPlace, waterUpdate]);
    // A day later, only the three-day one is left.
    expect(activeNotices([water, waterUpdate, info, danger, otherPlace], T + 24 * 3600)).toEqual([info]);
  });

  it('runs a notice heard from its author from when it arrived, whatever that phone\'s clock says', () => {
    const drawerPhone = { ...notice(1, 'danger', T - 3 * 365 * 86400, 24, 'Bridge'), at: T * 1000, hops: 0 };
    expect(activeNotices([drawerPhone], T + 3600)).toEqual([drawerPhone]);
    expect(activeNotices([drawerPhone], T + 25 * 3600)).toEqual([]);
  });

  it('counts a notice dated in the future from when it arrived', () => {
    const forged = { ...notice(1, 'danger', 0xffffffff, 1), at: T * 1000 };
    const update = notice(1, 'danger', T + 600, 1);
    expect(activeNotices([forged, update], T + 700)).toEqual([update]);
    expect(activeNotices([forged], T + 2 * 3600)).toEqual([]);
  });
});
