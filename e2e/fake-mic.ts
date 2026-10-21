import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BROADCAST, HEADER_LEN, PacketType, encodePacket, nodeLabel, randomNodeId, randomU32 } from '../src/mesh/packet';
import { encodeBody, nowSec } from '../src/mesh/payloads';
import { addNoise, mix, rng, wav } from '../src/modem/channel-sim';
import { modulate } from '../src/modem/modulator';
import { PROFILES, type ProfileId } from '../src/modem/profiles';

export const FAKE_MIC_WAV = fileURLToPath(new URL('.out/fake-mic.wav', import.meta.url));

/** Environment variable through which global setup tells the tests who sent the recording. */
export const FAKE_MIC_SENDER = 'RESONANCE_FAKE_MIC_SENDER';

/** Every modem profile the app has; the recording carries one message on each. */
export const FAKE_MIC_PROFILES = Object.keys(PROFILES) as ProfileId[];

const NICK = 'fake mic';
export const fakeMicText = (profile: ProfileId) => `Hello from the fake microphone (${profile})`;
const body = (profile: ProfileId) => encodeBody({ kind: 'text', ts: nowSec(), nick: NICK, text: fakeMicText(profile) });
/** Size of that message's packet on air, as the air log reports it. */
export const fakeMicBytes = (profile: ProfileId) => HEADER_LEN + body(profile).length;

/**
 * Renders a broadcast text packet per profile with the app's own modulator into one WAV that
 * Chromium plays as its microphone, on a loop. Returns the sender's node label.
 */
export function writeFakeMic(fs = 48000): string {
  const src = randomNodeId();
  const r = rng(src);
  const quiet = fs;
  const parts: Array<[number, Float32Array]> = [];
  let at = quiet;
  for (const profile of FAKE_MIC_PROFILES) {
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
      body: body(profile),
    });
    const frame = modulate(packet, PROFILES[profile], fs).map((v) => v * 0.5);
    parts.push([at, frame]);
    at += frame.length + quiet;
  }
  // A second of quiet room around each frame, then mild noise over the whole take.
  const take = addNoise(mix(at, parts, 0.002, r), 20, r);
  mkdirSync(fileURLToPath(new URL('.out/', import.meta.url)), { recursive: true });
  writeFileSync(FAKE_MIC_WAV, wav(take, fs));
  return nodeLabel(src);
}
