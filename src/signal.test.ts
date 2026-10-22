import { describe, expect, it } from 'vitest';
import { Links, strength } from './signal';

describe('signal in plain words', () => {
  it("rates a frame by how far it is above where its mode stops decoding", () => {
    // Measured on the simulated channel: Audible in a quiet room reports about 25 dB and fails
    // below about 10; Fast fails below about 7.
    expect(strength('audible', 25)).toBe('strong');
    expect(strength('ultrasonic', 16)).toBe('fair');
    expect(strength('audible', 12)).toBe('weak');
    expect(strength('fast', 20)).toBe('strong');
    expect(strength('fast', 12)).toBe('fair');
    expect(strength('fast', 9)).toBe('weak');
  });

  it('judges a neighbour by its last few frames on the mode it uses now, not by one lucky frame', () => {
    const links = new Links();
    expect(links.get(5)).toBeNull();
    links.add(5, { profile: 'fast', snrDb: 30, at: 1000 });
    for (const [snrDb, at] of [[11, 2000], [26, 3000], [24, 4000]]) links.add(5, { profile: 'audible', snrDb, at });
    expect(links.get(5)).toEqual({ profile: 'audible', strength: 'strong', at: 4000 });
    for (let i = 0; i < 5; i++) links.add(5, { profile: 'audible', snrDb: 12, at: 5000 + i });
    expect(links.get(5)).toEqual({ profile: 'audible', strength: 'weak', at: 5004 });
    expect(links.get(6)).toBeNull();
  });
});
