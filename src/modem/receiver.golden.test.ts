import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { addNoise, mix, resample, reverb, rng } from './channel-sim';
import { modulate } from './modulator';
import { PROFILES } from './profiles';
import { Receiver } from './receiver';

// A golden master of the receiver, recorded before its hot path was reworked: every listener
// call, in order, tagged with the push it came in, and the busy flag after every push, at full
// float precision. The modem tests check that frames decode; this checks that a change to the
// plumbing changes nothing at all, down to which profile reports first when two report in one
// push. If a snapshot here changes, the change is wrong, not the snapshot.

const ALL = Object.values(PROFILES);
const digest = (b: Uint8Array) => createHash('sha256').update(b).digest('hex').slice(0, 16);

/** Six frames on the three profiles in turn, every other one through a room, each sender on its own clock. */
function sequential(seed: number, fs: number) {
  const r = rng(seed);
  const parts: Array<[number, Float32Array]> = [];
  let off = Math.floor(r() * fs);
  for (let i = 0; i < 6; i++) {
    const payload = Uint8Array.from({ length: 1 + Math.floor(r() * 255) }, () => Math.floor(r() * 256));
    let sig = modulate(payload, ALL[i % 3], 48000);
    if (i % 2) sig = reverb(sig, 48000, 0.3, 6, r);
    sig = resample(sig, (1 + (r() - 0.5) * 0.008) * (48000 / fs));
    parts.push([off, sig]);
    off += sig.length + Math.floor((0.2 + r()) * fs);
  }
  return addNoise(mix(off + fs, parts, 0.01, r), 8, r);
}

/** Nine frames that each start 20% to 90% of the way through the last, so one profile syncs while another finishes. */
function overlapping(seed: number, fs: number) {
  const r = rng(seed);
  const parts: Array<[number, Float32Array]> = [];
  let off = Math.floor(r() * fs);
  for (let i = 0; i < 9; i++) {
    const payload = Uint8Array.from({ length: 1 + Math.floor(r() * 120) }, () => Math.floor(r() * 256));
    const sig = resample(modulate(payload, ALL[(i + seed) % 3], 48000), (1 + (r() - 0.5) * 0.004) * (48000 / fs));
    parts.push([off, sig]);
    off += Math.floor(sig.length * (0.2 + 0.7 * r()));
  }
  return addNoise(mix(Math.max(...parts.map(([o, s]) => o + s.length)) + fs, parts, 0.01, r), 14, r);
}

/** One full-size MFSK frame through a room, from a sender whose clock glides by `glide` during it. */
function gliding(pid: 'audible' | 'ultrasonic', seed: number, glide: number, fs: number) {
  const r = rng(seed);
  const payload = Uint8Array.from({ length: 255 }, () => Math.floor(r() * 256));
  const ratio = (1 + (r() - 0.5) * 0.008) * (48000 / fs);
  const sig = resample(reverb(modulate(payload, PROFILES[pid], 48000), 48000, 0.3, 3, r), ratio, ratio + glide);
  return addNoise(mix(sig.length + fs, [[Math.floor(r() * fs), sig]], 0.01, r), 6, r);
}

/** Pushes where the flag was set, as ranges: "#3-#9, #15". */
function spans(flags: boolean[]) {
  const out: string[] = [];
  for (let i = 0; i < flags.length; i++) {
    if (!flags[i] || flags[i - 1]) continue;
    let j = i;
    while (flags[j + 1]) j++;
    out.push(j > i ? `#${i}-#${j}` : `#${i}`);
  }
  return out.join(', ') || 'none';
}

/** Feeds `x` in chunks, then `tail` samples of silence in one push (as importRecording does), and logs it all. */
function record(x: Float32Array, fs: number, chunk: number, tail = 0): string[] {
  const log: string[] = [];
  const busy: boolean[] = [];
  const at = () => `#${busy.length}`;
  const rx = new Receiver(fs, ALL, {
    frame: (f) =>
      log.push(`${at()} frame ${f.profile} start=${f.startSample} air=${f.airtimeSec} clock=${f.clockRatio} snr=${f.toneSnrDb} fixed=${f.corrected} payload=${f.payload.length}B:${digest(f.payload)}`),
    sync: (p) => log.push(`${at()} sync ${p}`),
    lost: (p, why) => log.push(`${at()} lost ${p} ${why}`),
  });
  const push = (c: Float32Array) => {
    rx.push(c);
    busy.push(rx.busy);
  };
  for (let i = 0; i < x.length; i += chunk) push(x.subarray(i, i + chunk));
  if (tail) push(new Float32Array(tail));
  return [...log, `busy after ${spans(busy)} of ${busy.length} pushes`];
}

describe('receiver golden master', () => {
  it.each([
    [1, 48000, 2048],
    [2, 44100, 2048],
    [3, 48000, 333],
    [4, 48000, 4096],
  ])('sequential frames, seed %i, %i Hz, %i-sample chunks', (seed, fs, chunk) => {
    expect(record(sequential(seed, fs), fs, chunk, fs)).toMatchSnapshot();
  });

  // Seeds 6, 7 and 8 report events of two profiles in one push.
  it.each([
    [5, 48000, 2048],
    [6, 44100, 4096],
    [7, 48000, 1024],
    [8, 48000, 48000],
  ])('overlapping frames, seed %i, %i Hz, %i-sample chunks', (seed, fs, chunk) => {
    expect(record(overlapping(seed, fs), fs, chunk, fs)).toMatchSnapshot();
  });

  // Seed 4 loses its body: the MFSK failure path is pinned as well.
  it.each([
    ['audible', 1, 0, 48000],
    ['ultrasonic', 2, 0, 48000],
    ['audible', 3, 0.004, 48000],
    ['ultrasonic', 4, 0.003, 44100],
    ['audible', 5, -0.004, 44100],
  ] as const)('%s 255 B frame, seed %i, clock glide %f, %i Hz', (pid, seed, glide, fs) => {
    expect(record(gliding(pid, seed, glide, fs), fs, 2048)).toMatchSnapshot();
  });
});
