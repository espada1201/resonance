import { describe, expect, it } from 'vitest';
import { bearingDeg, compassPoint, distanceM, formatDistance, offset } from './geo';

const london = { lat: 51.5074, lon: -0.1278, accuracyM: 0 };
const paris = { lat: 48.8566, lon: 2.3522, accuracyM: 0 };

describe('geo', () => {
  it('matches reference great-circle distance and bearing (London → Paris)', () => {
    expect(distanceM(london, paris) / 1000).toBeCloseTo(343.6, 0);
    expect(bearingDeg(london, paris)).toBeCloseTo(148.1, 0);
    expect(compassPoint(bearingDeg(london, paris))).toBe('SE');
  });

  it('handles short hops and formats them for people', () => {
    const a = { lat: 40, lon: -74, accuracyM: 5 };
    const b = { lat: 40.001, lon: -74, accuracyM: 5 };
    expect(distanceM(a, b)).toBeCloseTo(111.2, 0);
    expect(compassPoint(bearingDeg(a, b))).toBe('N');
    expect(offset(a, b)).toBe('110 m N');
    expect(offset(a, { ...a, lat: 40.00005 })).toBeNull();
    expect(formatDistance(111.2)).toBe('110 m');
    expect(formatDistance(2345)).toBe('2.3 km');
  });
});
