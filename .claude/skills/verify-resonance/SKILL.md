---
name: verify-resonance
description: Launch the built Resonance web app (the phone app and the beacon page) and prove a feature works by driving it in Chromium on simulated air or a fake microphone. Use before claiming any Resonance change works, and to verify the features in features/.
---

# Verify Resonance

Resonance is a browser app. Users touch two pages: the phone app at `/` and the beacon at `/beacon.html`. Every journey runs against the production build served by `vite preview`, never the dev server.

Two seams make it drivable without speakers:

- `?air=sim` puts every tab of one browser context in the same simulated room. Frames are really modulated, mixed with noise and demodulated, just not played aloud. The page starts listening by itself. `&at=x,y` places the tab in metres, which Find needs.
- The microphone journeys play a WAV rendered by the app's own modulator into Chromium's fake capture device (see `e2e/fake-mic.ts`).

The helper is `.claude/skills/verify-resonance/verify.sh`. Run it from anywhere in the repo. `PORT` picks the instance (default 4193), so parallel runs each take their own port.

## Launch

```sh
.claude/skills/verify-resonance/verify.sh launch
```

It builds (`npm run build`: typecheck, then Vite), starts `vite preview` on `PORT`, and prints `ready: http://localhost:4193/ (pid N)` once the page answers with its title. A fresh browser context is empty storage, so there is nothing to seed or migrate. It refuses a port another process holds.

## Doctor

```sh
.claude/skills/verify-resonance/verify.sh doctor
```

Read-only. `OK` means the pid it started owns the port and serves `dist/` exactly as built, and it names the commit. A `WARNING` that a file changed after the build means relaunch before you drive: you would be verifying old code.

## Drive

Each feature file in `features/` names its journey as a Playwright spec and test title:

```sh
.claude/skills/verify-resonance/verify.sh drive e2e/messaging.spec.ts 'two stations trade messages'
```

Playwright reuses the running instance (`E2E_PORT`), so it does not rebuild. Locate elements by role and accessible name, as the specs do. The app labels every control for that. Shared steps live in `e2e/helpers.ts`: `joinAir` (open a station and wait for its first hello to clear the air), `sendText`, `openTab`, `feedItem`, `checkInRow`, `airRow`, `stat`, `nodeId`, and `playPacket` (play a packet built byte by byte into a page's simulated room, as a stranger in earshot could).

To prove behaviour that no journey covers yet, add a test to the feature's spec and drive that. The proof then stays as a regression test.

## Evidence

Each journey ends with `proof(page, name)`, which writes `e2e/.out/verify/<spec>/<name>.png` and `<name>.aria.txt` (the accessibility tree). A run is proven when:

- the journey passed through the user path (tabs, buttons, file inputs), not by calling station methods;
- its assertions check the end state on the receiving device as well as the sender, since sound is the side effect;
- the evidence files exist after cleanup.

Playwright traces of failed runs land in `e2e/.out/results/`, which every run clears. Copy one out before driving again if you need it.

## Cleanup

```sh
.claude/skills/verify-resonance/verify.sh cleanup
```

It stops only the pid it started, never by process name, and keeps `e2e/.out/verify/`.

## Gotchas

- Sound is slow. One message takes 3 to 13 s on air, a tiny file a few minutes. The suite's 60 s expect timeout is deliberate. Never shorten it to make a run faster.
- Stations that start together collide with each other's first hello. `joinAir` waits for the air to clear. Do the same in new journeys.
- Simulated air is per browser context. Pages in different contexts cannot hear each other.
- `npm run e2e` with no `E2E_PORT` reuses whatever answers on 4173, which may be an old build. Doctor guards the verify instance only.
