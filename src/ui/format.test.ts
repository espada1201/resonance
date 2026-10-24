import { describe, expect, it } from 'vitest';
import type { Station } from '../station';
import { TAKE_BACK_MS, nameless, takeBackOffered } from './checkin-form';
import { joinParts, passedOnText } from './format';

describe('joinParts', () => {
  it('joins what is there and leaves out what is empty, false or missing', () => {
    expect(joinParts(' · ', 'Floor 4', '', undefined, 'sent just now', false, null)).toBe('Floor 4 · sent just now');
    expect(joinParts(' ', 'Sent.', false)).toBe('Sent.');
    expect(joinParts(' · ')).toBe('');
  });

  it('keeps a part that reads 0', () => {
    expect(joinParts(', ', '0', 'a')).toBe('0, a');
  });
});

describe('nameless', () => {
  const station = (nick: string) => ({ id: 0xabcdef, settings: { nick } }) as unknown as Station;

  it('asks for a name when a check-in for oneself went out without one', () => {
    expect(nameless(station(''), undefined)).toBe('Others see you as #ABCDEF. Type your name in the box above, then send again.');
  });

  it('says nothing once there is a name, or when the check-in was about someone else', () => {
    expect(nameless(station('Ana'), undefined)).toBe('');
    expect(nameless(station(''), 'Maria')).toBe('');
  });
});

describe('passedOnText', () => {
  it('counts the phones a message went through in plain numbers, not "once"', () => {
    expect(passedOnText(1)).toBe('passed along 1 time');
    expect(passedOnText(3)).toBe('passed along 3 times');
  });
});

describe('takeBackOffered', () => {
  const sent = { at: 1_000_000 };

  it('offers the take-back from the moment the request went out until ten minutes later, and not after', () => {
    expect(TAKE_BACK_MS).toBe(10 * 60_000);
    expect(takeBackOffered(sent, sent.at)).toBe(true);
    expect(takeBackOffered(sent, sent.at + TAKE_BACK_MS - 1)).toBe(true);
    expect(takeBackOffered(sent, sent.at + TAKE_BACK_MS)).toBe(false);
  });

  it('offers nothing when no request was sent from here', () => {
    expect(takeBackOffered(null, sent.at)).toBe(false);
  });
});
