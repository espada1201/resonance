import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BROADCAST, PacketType, encodePacket, nodeLabel, randomNodeId, randomU32 } from '../src/mesh/packet';
import { encodeBody, nowSec } from '../src/mesh/payloads';
import { addNoise, mix, rng, wav } from '../src/modem/channel-sim';
import { modulate } from '../src/modem/modulator';
import { PROFILES, type ProfileId } from '../src/modem/profiles';

const OUT = fileURLToPath(new URL('.out/', import.meta.url));

export const FAKE_MIC_TEXT: Record<ProfileId, string> = {
  audible: 'Hello from the fake microphone',
  ultrasonic: 'Quiet hello from the fake microphone',
};

export const fakeMicWav = (profile: ProfileId) => `${OUT}fake-mic-${profile}.wav`;

/** Environment variable through which global setup tells the tests who sent the recording. */
export const fakeMicSenderVar = (profile: ProfileId) => `RESONANCE_FAKE_MIC_SRC_${profile.toUpperCase()}`;

/**
 * Renders one broadcast text packet with the app's own modulator into a WAV that Chromium
 * plays as its microphone (on a loop). Returns the sender's node label.
 */
export function writeFakeMic(profile: ProfileId, fs = 48000): string {
  const src = randomNodeId();
  const body = encodeBody({ kind: 'text', ts: nowSec(), nick: 'fake mic', text: FAKE_MIC_TEXT[profile] });
  const packet = encodePacket({
    type: PacketType.Text,
    encrypted: false,
    ackRequested: false,
    msgId: randomU32(),
    src,
    dst: BROADCAST,
    ttl: 5,
    hops: 0,
    attempt: 0,
    channel: 0,
    body,
  });
  const frame = modulate(packet, PROFILES[profile], fs).map((v) => v * 0.5);
  const r = rng(src);
  // A second of quiet room either side of the frame, then mild noise over the whole take.
  const take = addNoise(mix(fs + frame.length + fs, [[fs, frame]], 0.002, r), 20, r);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(fakeMicWav(profile), wav(take, fs));
  return nodeLabel(src);
}
