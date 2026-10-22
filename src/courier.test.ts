import { describe, expect, it } from 'vitest';
import { courierLink, courierText, parcels, parseOutside } from './courier';
import type { Need } from './mesh/payloads';
import type { CheckInBody, Heard, ReplyBody } from './roster';

const T = 1_700_000_000;
let ids = 0;
const checkIn = (src: number, ts: number, extra: Partial<CheckInBody>): Heard<CheckInBody> => ({
  src,
  msgId: ++ids,
  at: ts * 1000,
  hops: 1,
  encrypted: false,
  body: { kind: 'checkin', ts, nick: `n${src}`, status: 'safe', note: '', ...extra },
});
const passedOn = (c: Heard<CheckInBody>): Heard<ReplyBody> => ({
  src: 9,
  msgId: ++ids,
  at: 0,
  hops: 0,
  encrypted: false,
  body: { kind: 'reply', ts: c.body.ts + 60, nick: 'ben', what: 'passed', src: c.src, msgId: c.msgId },
});
const NEED_TEXT = { trapped: 'Trapped', water: 'Water' } as Record<Need, string>;

describe('courier to the outside', () => {
  it('accepts plain phone numbers and email addresses only', () => {
    expect(parseOutside(' +1 (555) 010-0100 ')).toEqual({ channel: 'sms', to: '+15550100100' });
    expect(parseOutside('0612 345 678')).toEqual({ channel: 'sms', to: '0612345678' });
    expect(parseOutside('maria.lopez+family@mail.example.org')).toEqual({ channel: 'email', to: 'maria.lopez+family@mail.example.org' });
    // From strangers on the air: nothing that could add recipients, a body or a script to the link.
    expect(parseOutside('555 0100')).toEqual({ channel: 'sms', to: '5550100' });
    const encodedRecipients = 'fam%2Cspy%40evil.com%2Cb@family.com';
    const shortCodes = ['55555', '+12345', '87 654'];
    for (const bad of ['a@b.com?bcc=c@d.com', 'a@b.com&body=x', 'javascript:alert(1)', '1234', 'mum', 'a b@c.de', '+1 555 0100?body=x', encodedRecipients, ...shortCodes]) {
      expect(parseOutside(bad)).toBeNull();
    }
  });

  it('lists the latest news for each person and address, and marks what was passed on', () => {
    const old = checkIn(1, T, { status: 'help', outside: '+1 555 0100' });
    const latest = checkIn(1, T + 600, { status: 'safe', outside: '+1 555 0100' });
    const toWork = checkIn(1, T + 30, { outside: 'boss@work.example' });
    const forMaria = checkIn(1, T + 900, { about: 'Maria', outside: '+1 555 0199' });
    const none = checkIn(2, T + 1000, {});
    const junk = checkIn(3, T + 1100, { outside: 'call me' });
    const p = parcels([old, latest, toWork, forMaria, none, junk], [passedOn(toWork)]);
    expect(p.map((x) => [x.checkin, x.address.to, !!x.passed])).toEqual([
      [forMaria, '+15550199', false],
      [latest, '+15550100', false],
      [toWork, 'boss@work.example', true],
    ]);
  });

  it('writes a text the family can act on', () => {
    const c = checkIn(1, T, { status: 'help', needs: ['trapped', 'water'], place: 'Floor 4, room 412', note: 'door jammed', geo: { lat: 35.595121, lon: -82.551512, accuracyM: 20 } });
    expect(courierText(c.body, 'Ana', '22 Oct, 14:02', NEED_TEXT)).toBe(
      'Ana needs help (trapped, water). Place: Floor 4, room 412. "door jammed" Map: https://www.google.com/maps?q=35.59512,-82.55151 ' +
        "Sent 22 Oct, 14:02 over Resonance, an offline network made of sound; a stranger's phone with signal passed it on, so replies will not reach them.",
    );
    expect(courierText(checkIn(2, T, { about: 'Maria López' }).body, 'Ben', '22 Oct, 15:00', NEED_TEXT)).toMatch(/^Maria López \(reported by Ben\) is safe\. Sent 22 Oct/);
  });

  it('opens the text or mail app with the message filled in', () => {
    expect(courierLink({ channel: 'sms', to: '+15550100' }, 'ignored', 'Ana is safe & well')).toBe('sms:+15550100?&body=Ana%20is%20safe%20%26%20well');
    expect(courierLink({ channel: 'email', to: 'a@b.example' }, 'From Ana', 'Line 1\nLine 2')).toBe('mailto:a@b.example?subject=From%20Ana&body=Line%201%0ALine%202');
  });
});
