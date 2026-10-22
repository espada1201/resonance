import { describe, expect, it } from 'vitest';
import { gaussian, rng } from './channel-sim';
import { PingDetector, renderPing } from './ping';

// A golden master of the ping detector (see receiver.golden.test.ts): every ping it reports,
// tagged with the push it came in, at full float precision.

/** 20 s of hiss with pings at random times and loudness, each followed 6 ms later by a louder echo. */
function room(seed: number, fs: number) {
  const r = rng(seed);
  const x = new Float32Array(20 * fs).map(() => 0.01 * gaussian(r));
  const ping = renderPing(fs);
  for (let t = 0.5; t < 19; t += 0.7 + r()) {
    const at = Math.round(t * fs);
    const g = 0.05 + r();
    for (let i = 0; i < ping.length; i++) x[at + i] += g * ping[i];
    for (let i = 0; i < ping.length; i++) x[at + 300 + i] += 1.3 * g * ping[i];
  }
  return x;
}

describe('ping detector golden master', () => {
  it.each([
    [48000, 1024, 1],
    [44100, 2048, 2],
    [48000, 333, 3],
    [44100, 4096, 4],
  ])('%i Hz, %i-sample chunks, seed %i', (fs, chunk, seed) => {
    const x = room(seed, fs);
    const log: string[] = [];
    let push = 0;
    const det = new PingDetector(fs, (p) => log.push(`#${push} pos=${p.pos} rho=${p.rho}`));
    for (let i = 0; i < x.length; i += chunk, push++) det.push(x.subarray(i, i + chunk));
    expect(log).toMatchSnapshot();
  });
});
