# Getting on the air

The first screen asks for the microphone, or offers simulated air: one room shared by the tabs of a browser, for trying Resonance without a microphone.

## Sub-features

- `start-two-tabs` `Try it in two tabs, no microphone` puts this tab on simulated air and opens a second one beside it.

## How to get to it (user POV)

- The first screen of the app, before `Start listening`.

## Driving it with verify.sh

Preconditions: none beyond the baseline.

- **Two tabs.** Run `verify.sh drive e2e/start.spec.ts 'Try it in two tabs'`. Both tabs show the `Simulated air` chip (`Sim` when narrow).

## Gotchas

- The second tab stands 3 m from the first.
- A tab on simulated air keeps nothing between visits, so each one is a new device.
