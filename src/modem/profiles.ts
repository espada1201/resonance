export type ProfileId = 'audible' | 'fast' | 'ultrasonic';

/** Every frame opens with two identical up-chirps (sync and clock-ratio estimate), then silence. */
interface Preamble {
  id: ProfileId;
  label: string;
  chirpLowHz: number;
  chirpHighHz: number;
  chirpSec: number;
  chirpGapSec: number;
  quietSec: number;
}

/**
 * A multi-tone FSK air interface. Each symbol carries one byte: `groups` (2) simultaneous
 * tones, each picking one of 16 frequencies (4 bits). Tones sit on a grid of `binHz`, and the
 * receiver integrates exactly 1/binHz seconds, so every tone is orthogonal to its neighbours.
 * A guard interval in front of each window lets room echoes from the previous symbol die down,
 * and `hopSets` alternates consecutive symbols between disjoint tone sets so echoes never land
 * on the bins currently being measured.
 */
export interface MfskProfile extends Preamble {
  kind: 'mfsk';
  baseHz: number;
  binHz: number;
  groups: number;
  hopSets: number;
  guardSec: number;
}

/**
 * OFDM with differential QPSK: `carriers` tones spaced 1/fftSec apart from firstHz, each
 * carrying 2 bits per symbol as a phase step from the same tone in the previous symbol, so the
 * receiver never has to learn the room's response. A cyclic prefix of cpSec swallows echoes
 * shorter than that. Its raw rate is about 15 times the audible profile's, but each tone gets a
 * sliver of the power, so it needs a strong, clean signal: devices close together.
 */
export interface OfdmProfile extends Preamble {
  kind: 'ofdm';
  firstHz: number;
  carriers: number;
  fftSec: number;
  cpSec: number;
  /** Consecutive symbols sound interleaved carrier sets, so a symbol's echo lands between the next one's carriers. */
  hopSets: number;
}

export type Profile = MfskProfile | OfdmProfile;

const audible: MfskProfile = {
  kind: 'mfsk',
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
};

const fast: OfdmProfile = {
  kind: 'ofdm',
  id: 'fast',
  label: 'Fast · 1.5–6.4 kHz · close range',
  firstHz: 1500,
  carriers: 212,
  fftSec: 2048 / 48000,
  cpSec: 512 / 48000,
  hopSets: 2,
  // A steeper sweep than the audible chirp, and a shorter gap: the audible preamble's chirp pair
  // correlates a little with this one, but never at this spacing.
  chirpLowHz: 1000,
  chirpHighHz: 7000,
  chirpSec: 0.06,
  chirpGapSec: 0.09,
  quietSec: 0.02,
};

const ultrasonic: MfskProfile = {
  kind: 'mfsk',
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
};

export const PROFILES = { audible, fast, ultrasonic };

export const TONES_PER_GROUP = 16;
export const windowSec = (p: MfskProfile) => 1 / p.binHz;
export const symbolSec = (p: Profile) => (p.kind === 'mfsk' ? p.guardSec + windowSec(p) : p.cpSec + p.fftSec);
/** Bytes one symbol carries: one per MFSK symbol, one per four sounding OFDM carriers. */
export const bytesPerSymbol = (p: Profile) => (p.kind === 'mfsk' ? 1 : Math.floor(p.carriers / p.hopSets) >> 2);
/** Seconds from the start of the first chirp to the start of the first data symbol. */
export const preambleSec = (p: Profile) => 2 * p.chirpSec + p.chirpGapSec + p.quietSec;
/** Raw channel rate in bits per second, before error correction and framing. */
export const rawBitrate = (p: Profile) => (8 * bytesPerSymbol(p)) / symbolSec(p);

/** Lowest and highest frequency the data symbols use. */
export const bandHz = (p: Profile): [number, number] =>
  p.kind === 'mfsk'
    ? [p.baseHz, p.baseHz + p.binHz * (p.hopSets * p.groups * TONES_PER_GROUP - 1)]
    : [p.firstHz, p.firstHz + (p.carriers - 1) / p.fftSec];

/** Whether audio running at `fs` samples a second can carry every tone of `p`, chirps included: each must sit below half the rate. */
export const playableAt = (p: Profile, fs: number) => Math.max(bandHz(p)[1], p.chirpHighHz) < fs / 2;
