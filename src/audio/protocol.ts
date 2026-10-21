import type { ProfileId } from '../modem/profiles';
import type { DecodedFrame } from '../modem/receiver';

export type ToWorker =
  | { type: 'init'; sampleRate: number }
  | { type: 'samples'; data: Float32Array }
  | { type: 'mute'; on: boolean };

export type FromWorker =
  | { type: 'frame'; frame: DecodedFrame }
  | { type: 'sync'; profile: ProfileId }
  | { type: 'lost'; profile: ProfileId; stage: 'header' | 'body' }
  | { type: 'spectrum'; bins: Float32Array; peak: number; fs: number }
  | { type: 'busy'; busy: boolean };
