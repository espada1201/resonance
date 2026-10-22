# Resonance

An offline mesh network made of sound. Phones and laptops pass messages through their speakers and microphones: no internet, no cell signal, no Bluetooth pairing, no accounts. Every device repeats what it hears and keeps it for 12 hours, so a message hops across a building or rides in a pocket to the next room. For blackouts, network shutdowns, air-gapped transfers, classrooms and festivals.

## Run on your Mac

1. Install Node once: open Terminal and run `brew install node` (no Homebrew yet? install it from https://brew.sh first).
2. Get the code: `git clone https://github.com/espada1201/resonance.git && cd resonance`
3. Start it: `npm install && npm start`. Your browser opens at http://localhost:4173.
4. Click **Start listening** and allow the microphone. No second device? Click **Try it in two tabs**.
5. To leave a laptop in a hallway as a relay, run `npm run beacon` instead.

## What it does

- **Messages**: text, "I'm safe" check-ins with an optional GPS pin shown as distance and direction from you, contact cards, and files up to 4 KB (photos are shrunk to fit). Direct messages are acknowledged and retried.
- **Private circles**: a shared passphrase seals what you write end to end (AES-256-GCM, key stretched with 600,000 rounds of PBKDF2). Which device sent what kind of packet, to whom and when stays visible.
- **Find**: two phones measure the distance between them by timing chirps back and forth.
- **See the air**: a live spectrum shows each frame arrive, decode and get relayed.
- **Beacon page**: a laptop listens, relays, and hands stored messages to phones that come within earshot.
- **Works offline**: after the first visit the app is cached and installable.

## Three modes, measured

| Mode | Band | Raw rate | Full 255-byte frame | Best for |
| --- | --- | --- | --- | --- |
| Audible | 1.2–4.4 kHz | 250 bit/s | 13.1 s | across a room, down a corridor |
| Fast | 1.5–6.4 kHz | 3,900 bit/s | 1.2 s | devices close together in a quiet room |
| Near-ultrasonic | 17.5–19.1 kHz | 160 bit/s | 20.3 s | quiet, same table |

You pick the mode you send in; every device listens in all three at once.

## How it works

Each frame opens with two chirps that mark its start and measure the sender's clock against ours. Audible and near-ultrasonic send one byte per symbol as two tones out of 16 each (MFSK). Fast uses OFDM: about a hundred tones at once, each carrying 2 bits as a phase step (DQPSK). Reed-Solomon codes repair damaged bytes and a CRC rejects anything still wrong. On top runs a flooding mesh: hop limits, duplicate suppression, random backoff, listen-before-talk, and HELLOs that summarise what each device holds in a Bloom filter, so neighbours fill each other's gaps. A lost piece of a file is resent by whichever device nearest the asker holds it.

With symbol timing known, the demodulators land within 0.25 dB of the textbook error rates for these modulations (Proakis; Pawula, Rice and Roberts).

## Tests

`npm test` runs the unit tests: the modem through simulated rooms (noise, echo, ±0.5% clock drift, random offsets), Reed-Solomon, the mesh, and the theory checks. `npm run e2e` drives the built app in Chromium: a fake microphone plays frames rendered by the app's own modulator, two pages talk over simulated air, and the app is checked offline and at phone width.

## Phones and GitHub Pages

Browsers only allow the microphone on https pages or on localhost, so phones need the published copy. GitHub Pages only serves public repositories on a free plan: keep the repo public, then turn Pages on once in Settings → Pages → Source: GitHub Actions, and press **Run workflow** under Actions → Pages. That publishes https://espada1201.github.io/resonance/, and every later push to the default branch updates it. Open it on a phone once and add it to the home screen.

## Known limits

- Tested in simulated rooms and with Chromium's fake microphone, not yet on real speakers. Phone speakers and microphones vary a lot.
- Fast mode needs the direct sound louder than the room's echo; it fails in very reverberant rooms.
- Many phones play little above 17 kHz, so near-ultrasonic may not work on them.
- Browsers stop the microphone when the screen locks or the tab is hidden, so a phone relays only while Resonance is open on screen. It asks to keep the screen on.
- Sound is slow and shared: everyone in earshot takes turns on the same air.

MIT licence.
