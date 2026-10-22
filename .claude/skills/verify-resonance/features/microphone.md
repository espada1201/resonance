# Microphone

The real capture path: the microphone feeds an audio worklet, the decoder worker finds frames, and messages land in the feed, in each of the three modes.

## Sub-features

- `mic-audible`, `mic-fast`, `mic-ultrasonic` a message played into the microphone in that mode appears in the feed, and the air log names the mode and size.
- `mic-one-tab` a second tab of the same browser does not listen while the first does: it says `already listening in another tab or window`, and listens once the first closes.

## How to get to it (user POV)

- The phone app without `?air=sim`, `Start listening`, and allow the microphone.

## Driving it with verify.sh

Preconditions: Chromium's fake capture device plays `e2e/.out/fake-mic.wav`, which the suite's global setup renders before any test.

- **Each mode.** Run `verify.sh drive e2e/microphone.spec.ts 'decodes the'`. Three tests pass, one per mode, each showing the `fake mic` message with `heard directly`.
- **One tab.** Run `verify.sh drive e2e/microphone.spec.ts 'a second tab'`. The second page shows the alert naming the other tab and stays on the start screen; after the first page closes, `Start listening` opens its feed.

## Gotchas

- The recording loops. The journey turns relaying off first so the station is not deaf while repeating what it heard.
- The audio runs at the output device's rate. Below about 38.4 kHz (a Bluetooth headset in call mode: 16 or 24 kHz) Near-ultrasonic cannot be carried: the station sends in Audible, Settings says so under the mode, and the decoder stops listening for it. At 8 kHz (a headset on its narrowband call codec) no mode can be carried: the station does not start, sends nothing, says to disconnect the headset and try again, and lets go of the microphone at once (its track ends). The next **Start listening** starts in place, without a reload. Proved by the unit tests `transmit mode` in src/station.test.ts and the journey: run `verify.sh drive e2e/microphone.spec.ts 'Bluetooth headset at 8 kHz'`, which runs the page's audio at 8 kHz, checks the alert and the ended track, then starts again at the device rate and decodes the fake microphone.
- A phone suspends its sound while its screen is locked or a call is on. A frame cut short then goes again whole once the sound is back, and nothing more starts meanwhile. While it is paused the air line reads `Sound paused by this device · tap to resume · N waiting` (`Tap to resume sound` in a phone's top bar), a frame it cut short ends `cut short: sound paused` in the air log, and Find says `Sound is paused on this device. Tap the screen to resume.` instead of blaming the volume. Proved by the unit tests `audio the phone took away` in src/audio/transport.test.ts and `audio the phone suspends` in src/station.test.ts, and the journey: run `verify.sh drive e2e/microphone.spec.ts 'pauses its sound'`, which holds the page's audio the way a locked screen does, sends a message that reads `waiting to go on air…`, then taps and sees it go out.
- Only one page per browser holds the listening lock (`resonance:listening` in Web Locks), so two phone tabs are never one device saving over each other's state. Simulated air (`?air=sim`) needs no lock: the journeys open several stations in one browser.
