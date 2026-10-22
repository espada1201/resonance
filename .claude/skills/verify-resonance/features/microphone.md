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
