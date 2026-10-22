# Microphone

The real capture path: the microphone feeds an audio worklet, the decoder worker finds frames, and messages land in the feed, in each of the three modes.

## Sub-features

- `mic-audible`, `mic-fast`, `mic-ultrasonic` a message played into the microphone in that mode appears in the feed, and the air log names the mode and size.

## How to get to it (user POV)

- The phone app without `?air=sim`, `Start listening`, and allow the microphone.

## Driving it with verify.sh

Preconditions: Chromium's fake capture device plays `e2e/.out/fake-mic.wav`, which the suite's global setup renders before any test.

- **Each mode.** Run `verify.sh drive e2e/microphone.spec.ts 'decodes the'`. Three tests pass, one per mode, each showing the `fake mic` message with `heard directly`.

## Gotchas

- The recording loops. The journey turns relaying off first so the station is not deaf while repeating what it heard.
- The audio runs at the output device's rate. Below about 38.4 kHz (a Bluetooth headset in call mode: 16 or 24 kHz) Near-ultrasonic cannot be carried: the station sends in Audible, Settings says so under the mode, and the decoder stops listening for it. Proved by the unit test `transmit mode` in src/station.test.ts; Chromium's fake device always runs at 48 kHz, so no journey covers it.
