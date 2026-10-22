import { wav } from '../modem/channel-sim';
import { modulate } from '../modem/modulator';
import { PROFILES, type Profile } from '../modem/profiles';
import { type DecodedFrame, Receiver } from '../modem/receiver';

// Sound files: any speaker can carry a packet. A packet saved as a WAV plays to the mesh from
// any device, and a recording of the air gives up every packet in it.

/** Renders a packet as a WAV file, with a quarter of a second of quiet either side. */
export function renderWav(bytes: Uint8Array, profile: Profile, fs = 48000): Blob {
  const wave = modulate(bytes, profile, fs);
  const padded = new Float32Array(wave.length + fs / 2);
  padded.set(wave, fs / 4);
  return new Blob([wav(padded, fs) as Uint8Array<ArrayBuffer>], { type: 'audio/wav' });
}

/** Every frame, in any profile, found in a mono recording. */
export async function decodeSamples(mono: Float32Array, fs: number): Promise<DecodedFrame[]> {
  const frames: DecodedFrame[] = [];
  const rx = new Receiver(fs, Object.values(PROFILES), { frame: (f) => frames.push(f) });
  for (let i = 0; i < mono.length; i += 4096) {
    rx.push(mono.subarray(i, i + 4096));
    // The search runs at about 45 times real time here, slower on a phone: let the page draw
    // between every second or so of sound, so a long recording does not freeze it.
    if (i % (16 * 4096) === 0) await new Promise((r) => setTimeout(r));
  }
  // Then a second of quiet, as if the recording had run on.
  rx.push(new Float32Array(fs));
  return frames;
}

/** Decodes a recording in any format the browser can, mixes it down to mono, and finds its frames. */
export async function decodeRecording(data: ArrayBuffer): Promise<DecodedFrame[]> {
  const ctx = new OfflineAudioContext(1, 1, 48000);
  const audio = await ctx.decodeAudioData(data);
  const mono = new Float32Array(audio.length);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const ch = audio.getChannelData(c);
    for (let i = 0; i < ch.length; i++) mono[i] += ch[i] / audio.numberOfChannels;
  }
  return decodeSamples(mono, audio.sampleRate);
}
