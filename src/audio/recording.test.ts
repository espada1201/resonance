import { afterEach, describe, expect, it, vi } from 'vitest';
import { modulate } from '../modem/modulator';
import { PROFILES } from '../modem/profiles';
import { decodeRecording, decodeSamples, renderWav } from './recording';

const payload = (seed: number) => Uint8Array.from({ length: 40 }, (_, i) => (seed * 71 + i * 37) & 0xff);
const quiet = (sec: number, fs: number) => new Float32Array(Math.round(sec * fs));

function concat(...parts: Float32Array[]) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => (out.set(p, at), at + p.length), 0);
  return out;
}

/** The samples of a 16-bit mono WAV, and its sample rate. */
async function readWav(blob: Blob) {
  const data = await blob.arrayBuffer();
  return { fs: new DataView(data).getUint32(24, true), samples: Float32Array.from(new Int16Array(data, 44), (x) => x / 32767) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('recordings', () => {
  it('finds every frame in a recording, whatever its profile, in the order played', async () => {
    const fs = 48000;
    const [a, b] = [payload(1), payload(2)];
    const recording = concat(quiet(0.5, fs), modulate(a, PROFILES.fast, fs), quiet(0.5, fs), modulate(b, PROFILES.audible, fs));
    const frames = await decodeSamples(recording, fs);
    expect(frames.map((f) => [f.profile, [...f.payload]])).toEqual([
      ['fast', [...a]],
      ['audible', [...b]],
    ]);
  });

  it('a packet saved as a WAV decodes back to the same bytes, at the rate it was rendered at', async () => {
    for (const fs of [48000, 44100]) {
      const a = payload(3);
      const { fs: rate, samples } = await readWav(renderWav(a, PROFILES.fast, fs));
      expect(rate).toBe(fs);
      expect(samples.length).toBe(modulate(a, PROFILES.fast, fs).length + fs / 2);
      expect((await decodeSamples(samples, fs)).map((f) => [...f.payload])).toEqual([[...a]]);
    }
  });

  it('lets the page run while it works through a long recording', async () => {
    // A ten-minute voice memo takes many seconds to search on a phone; the page must not freeze meanwhile.
    let turns = 0;
    const timer = setInterval(() => turns++, 0);
    await decodeSamples(quiet(20, 48000), 48000);
    clearInterval(timer);
    expect(turns).toBeGreaterThan(5);
  });

  it('a recording is mixed down to mono, so a frame on one channel of two still decodes', async () => {
    const fs = 44100;
    const a = payload(4);
    const right = concat(quiet(0.2, fs), modulate(a, PROFILES.fast, fs), quiet(0.2, fs));
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        async decodeAudioData() {
          return { length: right.length, numberOfChannels: 2, sampleRate: fs, getChannelData: (c: number) => (c === 1 ? right : new Float32Array(right.length)) };
        }
      },
    );
    expect((await decodeRecording(new ArrayBuffer(8))).map((f) => [...f.payload])).toEqual([[...a]]);
  });
});
