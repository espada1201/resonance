import { afterAll, describe, expect, it } from 'vitest';
import { addNoise, babble, clip, equalize, hum, mix, power, resample, reverb, rng, slams } from './channel-sim';
import { modulate } from './modulator';
import { PROFILES, type ProfileId } from './profiles';
import { type DecodedFrame, Receiver } from './receiver';

// The modem's envelope in real rooms: for each profile, the share of seeded 64-byte frames that
// decode exactly under what phones and laptops meet in a shelter, a stairwell or a flat. Levels are
// relative to the frame's own average power. Each floor sits a frame or two under what 12 frames
// measured; a floor of 0 marks a condition beyond that profile's reach. RESONANCE_SWEEP=<frames per
// cell> runs every row and prints the table; the default run takes the rows marked quick.

const ALL = Object.values(PROFILES);
const IDS: ProfileId[] = ['audible', 'fast', 'ultrasonic'];
const SWEEP = Number(process.env.RESONANCE_SWEEP ?? 0);

const peak = (x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const add = (x: Float32Array, y: Float32Array, gain: number) => x.map((v, i) => v + gain * y[i]);
/** `x` plus `noise` at `sirDb` below power `p`. */
const under = (x: Float32Array, noise: Float32Array, p: number, sirDb: number) => add(x, noise, Math.sqrt(p / 10 ** (sirDb / 10) / power(noise)));

const bump = (hz: number, at: number, db: number) => db * Math.exp(-((Math.log2(hz / at) / 0.15) ** 2));
/** A small phone's loudspeaker: little below 450 Hz, peaks and notches of ±6 dB, then falling `topDbPerKhz` above 17 kHz. */
const phone = (topDbPerKhz: number) => (hz: number) =>
  -10 * Math.log10(1 + (450 / hz) ** 4) +
  bump(hz, 1000, 6) + bump(hz, 1700, -6) + bump(hz, 2600, 6) + bump(hz, 3700, -6) + bump(hz, 5000, 5) + bump(hz, 6000, -6) -
  Math.max(0, (topDbPerKhz * (hz - 17000)) / 1000);

interface Condition {
  name: string;
  /** The decode rate each profile is held to: audible, fast, ultrasonic. */
  floor: readonly [number, number, number];
  /** Runs by default, two frames per cell: a representative row of its kind, inside the envelope. */
  quick?: boolean;
  txFs?: number;
  rxFs?: number;
  /** What the microphone hears: `x` is the frame in a quiet stream, `frame` the frame alone. */
  air(x: Float32Array, frame: Float32Array, fs: number, r: () => number): Float32Array;
}

const room = (rt60: number, drrDb: number, ratio: number, endRatio: number, snrDb: number): Condition['air'] => (x, _f, fs, r) =>
  addNoise(resample(reverb(x, fs, rt60, drrDb, r), ratio, endRatio), snrDb, r);

const CONDITIONS: Condition[] = [
  ...(
    [
      [0, [0.9, 0.9, 0.9]],
      [-5, [0.9, 0.9, 0.9]],
      [-10, [0.9, 0.4, 0.9]],
      [-15, [0.25, 0, 0.9]],
      [-20, [0, 0, 0.25]],
    ] as const
  ).map(([sir, floor]) => ({
    name: `3 people talking nearby, SIR ${sir} dB`,
    floor,
    quick: sir === -5,
    air: (x: Float32Array, f: Float32Array, fs: number, r: () => number) => under(x, babble(x.length, fs, 3, r), power(f), sir),
  })),
  ...(
    [
      [10, [0.9, 0.9, 0.9]],
      [5, [0.9, 0.9, 0.9]],
      [0, [0.9, 0.5, 0.9]],
    ] as const
  ).map(([snr, floor]) => ({
    name: `phone speaker (top falls 10 dB/kHz), SNR ${snr} dB`,
    floor,
    quick: snr === 5,
    air: (x: Float32Array, _f: Float32Array, fs: number, r: () => number) => addNoise(equalize(x, fs, phone(10)), snr, r),
  })),
  ...(
    [
      [20, 10, [0.9, 0.9, 0.9]],
      [20, 0, [0.9, 0.5, 0.15]],
      [30, 10, [0.9, 0.9, 0]],
    ] as const
  ).map(([top, snr, floor]) => ({
    name: `phone speaker (top falls ${top} dB/kHz), SNR ${snr} dB`,
    floor,
    air: (x: Float32Array, _f: Float32Array, fs: number, r: () => number) => addNoise(equalize(x, fs, phone(top)), snr, r),
  })),
  ...(
    [
      [12, false, [0.9, 0.9, 0.9]],
      [20, false, [0.9, 0.4, 0.9]],
      [30, false, [0.9, 0, 0.9]],
      [12, true, [0.9, 0.9, 0.9]],
      [20, true, [0.9, 0.65, 0.9]],
      [30, true, [0.9, 0, 0.9]],
    ] as const
  ).map(([drive, soft, floor]) => ({
    name: `microphone ${soft ? 'soft' : 'hard'}-clipped ${drive} dB over full scale`,
    floor,
    quick: drive === 12 && !soft,
    air: (x: Float32Array, _f: Float32Array, _fs: number, r: () => number) => clip(addNoise(x, 30, r), drive, soft),
  })),
  ...(
    [
      [50, 0, [0.9, 0.9, 0.9]],
      [50, -10, [0.9, 0.5, 0.9]],
      [50, -20, [0.9, 0, 0.9]],
      [60, 0, [0.9, 0.9, 0.9]],
      [60, -10, [0.9, 0, 0.9]],
      [60, -20, [0.75, 0, 0.9]],
    ] as const
  ).map(([hz, sir, floor]) => ({
    name: `${hz} Hz mains hum, harmonics to 6 kHz, SIR ${sir} dB`,
    floor,
    quick: hz === 50 && sir === 0,
    air: (x: Float32Array, f: Float32Array, fs: number, r: () => number) => addNoise(under(x, hum(x.length, fs, hz, r), power(f), sir), 30, r),
  })),
  ...([2, 0.5] as const).map((every) => ({
    name: `door slams every ${every} s, peaks 10 dB over the frame's`,
    floor: [0.9, 0.9, 0.9] as const,
    quick: every === 0.5,
    air: (x: Float32Array, f: Float32Array, fs: number, r: () => number) => {
      const s = slams(x.length, fs, every, r);
      return addNoise(peak(s) ? add(x, s, (3.16 * peak(f)) / peak(s)) : x, 30, r);
    },
  })),
  { name: 'room RT60 0.3 s, DRR 3 dB, clock +0.4%, SNR 0 dB', floor: [0.9, 0, 0.9], air: room(0.3, 3, 1.004, 1.004, 0) },
  { name: 'room RT60 0.5 s, DRR 0 dB, clock -0.4%, SNR 0 dB', floor: [0.9, 0, 0.9], air: room(0.5, 0, 0.996, 0.996, 0) },
  { name: 'close in a room: RT60 0.3 s, DRR 10 dB, clock +0.4%, SNR 10 dB', floor: [0.9, 0.9, 0.9], quick: true, air: room(0.3, 10, 1.004, 1.004, 10) },
  ...([0.001, 0.002, 0.004, -0.004] as const).map((glide) => ({
    name: `sender's clock glides ${glide * 100}% in a room (RT60 0.3 s, DRR 3 dB, SNR 10 dB)`,
    floor: [0.9, 0, 0.9] as const,
    air: room(0.3, 3, 1, 1 + glide, 10),
  })),
  ...([[44100, 48000], [48000, 44100]] as const).flatMap(([txFs, rxFs]) =>
    ([100e-6, -100e-6] as const).map((ppm) => ({
      name: `${txFs / 1000} kHz sender into ${rxFs / 1000} kHz receiver, ${ppm * 1e6} ppm, SNR 10 dB`,
      floor: [0.9, 0.9, 0.9] as const,
      quick: ppm > 0,
      txFs,
      rxFs,
      air: (x: Float32Array, _f: Float32Array, _fs: number, r: () => number) => addNoise(resample(x, (txFs / rxFs) * (1 + ppm)), 10, r),
    })),
  ),
];

/** Sends one seeded 64-byte frame through the condition; true if it decodes exactly, and alone. */
function decodes(pid: ProfileId, c: Condition, seed: number) {
  const r = rng(seed);
  const fs = c.txFs ?? 48000;
  const payload = Uint8Array.from({ length: 64 }, () => Math.floor(r() * 256));
  const frame = modulate(payload, PROFILES[pid], fs);
  const at = Math.floor((r() * fs) / 2);
  const heard = c.air(mix(at + frame.length + fs / 2, [[at, frame]], 0, r), frame, fs, r);
  const frames: DecodedFrame[] = [];
  const rx = new Receiver(c.rxFs ?? fs, ALL, { frame: (f) => frames.push(f) });
  for (let i = 0; i < heard.length; i += 2048) rx.push(heard.subarray(i, i + 2048));
  return frames.length === 1 && frames[0].payload.join() === payload.join();
}

// The babble rows mean something only while the talkers sound like speech, whose long-term
// spectrum peaks below 1 kHz and falls about 6 dB per octave above it.
it('people talking: most of their power below 1 kHz, under 1% from 4 to 8 kHz, next to none from 17 to 20 kHz', () => {
  const fs = 48000;
  const talk = babble(4 * fs, fs, 3, rng(1));
  const share = (lo: number, hi: number) => power(equalize(talk, fs, (hz) => (hz >= lo && hz < hi ? 0 : -400))) / power(talk);
  expect(share(0, 1000)).toBeGreaterThan(0.8);
  expect(share(4000, 8000)).toBeLessThan(0.01);
  expect(share(17000, 20000)).toBeLessThan(1e-4);
});

const frames = SWEEP || 2;
const measured = new Map<string, number[]>();

describe.each(SWEEP ? CONDITIONS : CONDITIONS.filter((c) => c.quick))('$name', (c) => {
  it.each(IDS.map((pid, i) => [pid, i] as const))('%s', (pid, i) => {
    let ok = 0;
    for (let seed = 1000; seed < 1000 + frames; seed++) ok += Number(decodes(pid, c, seed));
    if (!measured.has(c.name)) measured.set(c.name, []);
    measured.get(c.name)![i] = ok / frames;
    expect(ok / frames).toBeGreaterThanOrEqual(c.floor[i]);
  });
});

afterAll(() => {
  if (!SWEEP) return;
  const head = `Decoded, of ${frames} frames per cell`.padEnd(80) + IDS.map((id) => id.padStart(11)).join('');
  const rows = [...measured].map(([name, v]) => name.padEnd(80) + v.map((x) => `${Math.round(x * 100)}%`.padStart(11)).join(''));
  process.stderr.write(`\n${head}\n${rows.join('\n')}\n`);
});
