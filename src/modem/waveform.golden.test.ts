import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { gaussian, rng } from './channel-sim';
import { magnitudeSpectrum } from './dsp';
import { chirpTemplate } from './matched';
import { modulate } from './modulator';
import { PING, renderPing } from './ping';
import { PROFILES } from './profiles';

// Golden hashes of everything the modem synthesises (see receiver.golden.test.ts): the bits of
// every waveform and template, so a refactor of how they are computed can prove it changes none.

const RATES = [44100, 48000];
const sha = (...xs: Array<Float32Array | Float64Array>) => {
  const h = createHash('sha256');
  for (const x of xs) h.update(new Uint8Array(x.buffer, x.byteOffset, x.byteLength));
  return h.digest('hex');
};

describe('waveform golden hashes', () => {
  it('modulate, every profile at both rates, for 1, 37 and 255 bytes', () => {
    const out: Record<string, string> = {};
    for (const p of Object.values(PROFILES)) {
      for (const fs of RATES) {
        for (const len of [1, 37, 255]) {
          const r = rng(len);
          out[`${p.id} ${fs} Hz ${len} B`] = sha(modulate(Uint8Array.from({ length: len }, () => Math.floor(r() * 256)), p, fs));
        }
      }
    }
    expect(out).toMatchSnapshot();
  });

  it('chirp templates (each profile and the ping) and the rendered ping, at both rates', () => {
    const out: Record<string, string> = {};
    for (const fs of RATES) {
      for (const p of Object.values(PROFILES)) {
        const t = chirpTemplate(p.chirpLowHz, p.chirpHighHz, Math.round(p.chirpSec * fs) / fs, fs);
        out[`${p.id} template ${fs} Hz`] = sha(t.re, t.im);
      }
      const t = chirpTemplate(PING.startHz, PING.endHz, PING.sec, fs);
      out[`ping template ${fs} Hz`] = sha(t.re, t.im);
      out[`renderPing ${fs} Hz`] = sha(renderPing(fs));
    }
    expect(out).toMatchSnapshot();
  });

  it('magnitudeSpectrum, the same on every call', () => {
    const r = rng(7);
    const x = Float32Array.from({ length: 3000 }, (_, i) => 0.5 * Math.sin(i * 0.3) + 0.1 * gaussian(r));
    const take = (input: Float32Array, n: number) => sha(magnitudeSpectrum(input, n));
    const first = {
      'last 2048 of 3000': take(x, 2048),
      'exactly 2048': take(x.subarray(0, 2048), 2048),
      '1500 into 2048 (zero padded)': take(x.subarray(0, 1500), 2048),
      'last 512': take(x, 512),
    };
    // Again, in another order: nothing one call leaves behind may reach the next.
    expect(take(x, 512)).toBe(first['last 512']);
    expect(take(x.subarray(0, 1500), 2048)).toBe(first['1500 into 2048 (zero padded)']);
    expect(take(x, 2048)).toBe(first['last 2048 of 3000']);
    expect(first).toMatchSnapshot();
  });
});
