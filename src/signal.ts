import type { ProfileId } from './modem/profiles';

// How well a neighbour comes across, in words. The receiver reports how far each frame's tones
// stand above the noise; where decoding gives out depends on the mode, so the words do too.
// Measured on the simulated channel (white noise, then a room with a 0.4 s echo): Audible and
// Near-ultrasonic decode down to about 10 dB, Fast down to about 7 dB.

export type Strength = 'strong' | 'fair' | 'weak';

export interface Link {
  profile: ProfileId;
  strength: Strength;
  /** When its last frame was heard. */
  at: number;
}

interface Sample {
  profile: ProfileId;
  snrDb: number;
  at: number;
}

const FLOOR_DB: Record<ProfileId, number> = { audible: 10, ultrasonic: 10, fast: 7 };
/** Frames a neighbour is judged by. */
const KEEP = 5;

/** Strong: 10 dB to spare. Fair: 4 to 10. Weak: a little more noise or distance and frames get lost. */
export function strength(profile: ProfileId, snrDb: number): Strength {
  const spare = snrDb - FLOOR_DB[profile];
  return spare >= 10 ? 'strong' : spare >= 4 ? 'fair' : 'weak';
}

/** The direct link to each neighbour, from frames it sent itself (a relayed frame says nothing about the path between us). */
export class Links {
  private readonly heard = new Map<number, Sample[]>();

  add(src: number, s: Sample) {
    const same = (this.heard.get(src) ?? []).filter((x) => x.profile === s.profile);
    this.heard.set(src, [...same, s].slice(-KEEP));
  }

  /** The median of the last few frames on the mode the neighbour uses now, rounding down. */
  get(src: number): Link | null {
    const list = this.heard.get(src);
    if (!list) return null;
    const last = list[list.length - 1];
    const snrs = list.map((x) => x.snrDb).sort((a, b) => a - b);
    return { profile: last.profile, strength: strength(last.profile, snrs[(snrs.length - 1) >> 1]), at: last.at };
  }
}
