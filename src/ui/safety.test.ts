import { describe, expect, it } from 'vitest';
import { BROADCAST } from '../mesh/packet';
import type { FeedItem } from '../station';
import { latestCheckIns } from './safety';

const checkIn = (msgId: number, status: 'help' | 'safe', sentSec: number, heardMs: number): FeedItem => ({
  id: `5:${msgId}`,
  src: 5,
  msgId,
  at: heardMs,
  hops: 1,
  mine: false,
  encrypted: false,
  locked: false,
  dst: BROADCAST,
  body: { kind: 'checkin', ts: sentSec, nick: 'Ana', status, note: '' },
});

describe('safety list', () => {
  it('an old "I need help" carried in late does not hide a newer "I\'m safe"', () => {
    // Newest arrival first: Ana's 10:30 "safe" was heard at 10:30, her 10:00 "help" only at 11:00.
    const ten = 1_700_000_000;
    const feed = [checkIn(1, 'help', ten, (ten + 3600) * 1000), checkIn(2, 'safe', ten + 1800, (ten + 1800) * 1000)];
    expect(latestCheckIns(feed).map((c) => c.body.status)).toEqual(['safe']);
  });
});
