# Getting on the air

The first screen asks for the microphone, or offers simulated air: one room shared by the tabs of a browser, for trying Resonance without a microphone.

## Sub-features

- `start-two-tabs` `Try it in two tabs, no microphone` puts this tab on simulated air and opens a second one beside it.
- `start-sim-ready` a page opened on simulated air is listening, with the message box, before its first hello goes out.

## How to get to it (user POV)

- The first screen of the app, before `Start listening`.

## Driving it with verify.sh

Preconditions: none beyond the baseline.

- **Two tabs.** Run `verify.sh drive e2e/start.spec.ts 'Try it in two tabs'`. Both tabs show the `Simulated air` chip (`Sim` when narrow).
- **Ready at once.** Run `verify.sh drive e2e/start.spec.ts 'before its first hello'`. With the page's clock paused one second in, the air reads `Listening` and the air log is still empty.

## Gotchas

- The second tab stands 3 m from the first.
- A tab on simulated air keeps nothing between visits, so each one is a new device.
- The ready journey runs on Playwright's fake clock: it holds the page's timers, not the decoder worker's.
