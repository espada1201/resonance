export type ProfileId = 'audible' | 'ultrasonic';

/**
 * A multi-tone FSK air interface. Each symbol carries one byte: `groups` (2) simultaneous
 * tones, each picking one of 16 frequencies (4 bits). Tones sit on a grid of `binHz`, and the
 * receiver integrates exactly 1/binHz seconds, so every tone is orthogonal to its neighbours.
 * A guard interval in front of each window lets room echoes from the previous symbol die down,
 * and `hopSets` alternates consecutive symbols between disjoint tone sets so echoes never land
 * on the bins currently being measured.
 */
export interface Profile {
  id: ProfileId;
  label: string;
  baseHz: number;
  binHz: number;
  groups: number;
  hopSets: number;
  guardSec: number;
  chirpLowHz: number;
  chirpHighHz: number;
  chirpSec: number;
  chirpGapSec: number;
  quietSec: number;
}

export const PROFILES: Record<ProfileId, Profile> = {
  audible: {
    id: 'audible',
    label: 'Audible · 1.2–4.4 kHz · long range',
    baseHz: 1200,
    binHz: 50,
    groups: 2,
    hopSets: 2,
    guardSec: 0.012,
    chirpLowHz: 1100,
    chirpHighHz: 4500,
    chirpSec: 0.06,
    chirpGapSec: 0.12,
    quietSec: 0.02,
  },
  ultrasonic: {
    id: 'ultrasonic',
    label: 'Near-ultrasonic · 17.5–19.1 kHz · quiet, short range',
    baseHz: 17500,
    binHz: 25,
    groups: 2,
    hopSets: 2,
    guardSec: 0.01,
    chirpLowHz: 17400,
    chirpHighHz: 19200,
    chirpSec: 0.06,
    chirpGapSec: 0.12,
    quietSec: 0.02,
  },
};

export const TONES_PER_GROUP = 16;
export const windowSec = (p: Profile) => 1 / p.binHz;
export const symbolSec = (p: Profile) => p.guardSec + windowSec(p);
/** Seconds from the start of the first chirp to the start of the first data symbol. */
export const preambleSec = (p: Profile) => 2 * p.chirpSec + p.chirpGapSec + p.quietSec;
/** Raw channel rate in bits per second (8 bits per symbol). */
export const rawBitrate = (p: Profile) => 8 / symbolSec(p);

/** Frequencies of all 16 tones of group `g` for symbol index `k`. */
export function groupTones(p: Profile, k: number, g: number): number[] {
  const set = k % p.hopSets;
  const first = (set * p.groups + g) * TONES_PER_GROUP;
  return Array.from({ length: TONES_PER_GROUP }, (_, v) => p.baseHz + p.binHz * (first + v));
}

/** The tone frequency carrying nibble `v` in group `g` of symbol `k`. */
export const toneHz = (p: Profile, k: number, g: number, v: number) =>
  p.baseHz + p.binHz * (((k % p.hopSets) * p.groups + g) * TONES_PER_GROUP + v);
