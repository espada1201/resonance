// Two-way acoustic ranging without synchronised clocks (Peng et al., "BeepBeep", SenSys 2007).
// A pings and hears its own ping at a1 and B's at a2; B hears A's at b1 and its own at b2.
// Each device only measures an interval on its own clock, so clock offsets cancel exactly:
//   distance = c/2 · ((a2 − a1) − (b2 − b1)) + (speaker-to-mic gap of A + of B) / 2

/** Speed of sound in dry air at 20 °C. */
export const SPEED_OF_SOUND = 343;
/** Typical distance between a phone's or laptop's speaker and its own microphone. */
export const SPEAKER_TO_MIC_M = 0.1;

export function twoWayDistance(intervalA: number, intervalB: number, selfA = SPEAKER_TO_MIC_M, selfB = SPEAKER_TO_MIC_M, c = SPEED_OF_SOUND) {
  return (c / 2) * (intervalA - intervalB) + (selfA + selfB) / 2;
}
