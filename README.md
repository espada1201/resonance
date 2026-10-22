# Resonance

An offline mesh network made of sound, for when the phone network is down: a power cut, a storm or a shutdown. Phones and laptops pass messages through their speakers and microphones, with no internet, no cell signal, no pairing and no accounts. Every device that hears a message repeats it, so it hops through a building. A laptop left plugged in as a beacon keeps what it heard for days and hands it to every phone that comes within earshot.

## Run on your Mac

1. Install Node once: open Terminal and run `brew install node`. If you have no Homebrew yet, install it from https://brew.sh first.
2. Get the code: `git clone https://github.com/espada1201/resonance.git && cd resonance`
3. Start it: `npm install && npm start`. Your browser opens at http://localhost:4173.
4. Click **Start listening** and allow the microphone. To try it without a second device, click **Try it in two tabs**.
5. To leave a laptop in a hallway as a beacon, run `npm run beacon` instead.

## What it does

- **Check in**: one tap says "I'm safe" or "I need help", with your GPS position if you allow it. Add what you need (trapped, injured, medicine, water…), where you are ("Floor 4, room 412"), or check in for someone without a phone.
- **Safety list**: everyone's latest check-in, with requests nobody has answered yet at the top, longest waiting first. **On my way** and **Resolved** tell everyone who is handling what. Asking again reopens a resolved request, and the list marks a request with no news for a day as stale. A new call for help buzzes the phone where the browser allows it (Android, not iPhone), and the page title counts open requests. Search by name, download a spreadsheet or print it for a shelter desk.
- **Word to family outside**: add a family phone number or email to your check-ins. Every phone that hears one lists it. Someone whose phone has signal taps **Send as text**, and their own text or mail app opens with your message filled in. Once they tap **I sent it**, everyone sees that they passed it on.
- **Notices**: "Drinking water at the school gym" stays pinned on every feed, and large on the beacon's screen, for as long as its author chose.
- **Messages and contacts**: text, direct messages with receipts (and **Send again** if none comes), contact cards that say what you can help with, files up to 4 KB.
- **Private circles**: a shared passphrase seals what you write (AES-256-GCM, PBKDF2 with 600,000 rounds). Still visible: which device sent what kind of packet, how big, to whom and when, your nickname in hellos, and which file pieces you ask for. Anyone can measure how far away you are with Find unless you turn off **Answer distance requests**. Resonance keeps the passphrase in this browser's storage.
- **Find**: two phones measure the distance between them by timing chirps.
- **Signal check**: People rates each neighbour's signal as strong, fair or weak; Air shows every frame arrive, decode and get relayed.
- **Sound files**: save a packet as a WAV to play from any speaker near a Resonance device, or decode packets from a recording.
- **Works offline**: after the first visit the browser caches the app; add it to the home screen so the browser keeps its data. A page left open across an update keeps working, and the update takes over once you close every Resonance page.

Each device keeps up to 300 packets: messages for 12 hours; check-ins, replies and notices for 3 days. When it is full, it drops chat and file pieces first, until check-ins, replies and notices hold more than 240 places, so a file being sent always fits. Past that, it drops a check-in first if the same phone sent a newer one about the same person and no reply answers it, and only then the oldest, so others checking in again never push out anyone's only check-in.

## Three modes, measured

| Mode | Band | Raw rate | Full 255-byte frame | Best for |
| --- | --- | --- | --- | --- |
| Audible | 1.2–4.4 kHz | 250 bit/s | 13.1 s | across a room, down a corridor |
| Fast | 1.5–6.4 kHz | 3,900 bit/s | 1.2 s | devices close together in a quiet room |
| Near-ultrasonic | 17.5–19.1 kHz | 160 bit/s | 20.3 s | quiet, same table |

You pick the mode you send in; every device listens in all three at once. Check-ins and replies go out ahead of chat and files. In simulated rooms, Audible and Near-ultrasonic still decode 9 frames in 10 with three people talking 10 dB louder than the chirps, and Fast does so with talk up to 5 dB louder. Fast fails in a room whose echo is nearly as loud as the sound itself. `RESONANCE_SWEEP=12 npm test` runs these measurements; the default run checks talk 5 dB louder.

## How it works

Each frame opens with two chirps that mark its start and measure the sender's clock against ours. Audible and near-ultrasonic send one byte per symbol as two tones out of 16 each (MFSK). Fast uses OFDM: about a hundred tones at once, each carrying 2 bits as a phase step (DQPSK). Reed-Solomon codes repair damaged bytes and a CRC rejects anything still wrong. On top runs a flooding mesh: hop limits, duplicate suppression, random backoff, listen-before-talk, and HELLOs that summarise what each device holds in a Bloom filter, so each neighbour sends what the other lacks. With symbol timing known, the demodulators come within 0.25 dB of the textbook error rates (Proakis; Pawula, Rice and Roberts).

## Tests

`npm test` runs the unit tests: the modem through simulated rooms (talkers, echo, hum, clipping, phone speakers, ±0.5% clock drift), Reed-Solomon, the mesh (including an exhaustive check on small networks that flooding stops, whatever order frames and timers come in), the safety list and courier, and the theory checks. `npm run e2e` drives the built app in Chromium: a fake microphone plays frames rendered by the app's own modulator, tabs talk over simulated air to test every feature above, and it checks the app offline and at phone width.

## Phones and GitHub Pages

Browsers only allow the microphone on https pages or on localhost, so phones need the published copy. GitHub Pages only serves public repositories on a free plan, so keep the repo public. Then turn Pages on once in Settings → Pages → Source: GitHub Actions, and press **Run workflow** under Actions → Pages. That publishes https://espada1201.github.io/resonance/, and every later push to the default branch updates it. Open it on a phone once and add it to the home screen. It needs a current Chrome, Edge, Firefox or Samsung Internet, or Safari on iOS 15.4 or later.

## Known limits

- All testing so far has used simulated rooms and Chromium's fake microphone, not real speakers. Phone speakers and microphones vary a lot.
- A phone listens and relays only while Resonance is open on screen. A locked phone neither listens nor sends. What you send waits, marked "waiting to go on air", until Resonance is on screen again. Keeping it open keeps the screen on, and we have not yet measured how long a battery lasts that way. A phone carries a message to another place only if its owner opens Resonance again there. Beacons keep what they hear.
- Sound is slow and shared. In our tests, a 4 KB photo took about 3 minutes in Fast and 14 in Audible. Of 24 messages sent 4 to 8 seconds apart between two phones, 5 needed a repeat (half a minute) and 1 waited 5 minutes for the next hello.
- Loud talk close by drowns out the chirps. In simulated rooms, with three people talking 15 dB louder than the chirps, Audible got 5 of 12 frames through and Fast none. At 20 dB louder, only Near-ultrasonic got any through, 5 of 12.
- Many phones play little above 17 kHz. A Bluetooth headset limits a phone's audio to call quality, which is too slow for Near-ultrasonic, so Resonance sends in Audible instead. On the oldest call codec (8 kHz), it asks you to disconnect the headset.
- Anyone in earshot can post under any name. Nothing proves who sent a check-in, reply, notice or contact card, so a false "I'm safe" or **Resolved** is possible (asking again reopens a request). Anyone loud enough can also drown out the room.
- Phone calls, voicemail and walkie-talkies cut the tones Resonance uses, so sound files do not survive them. For that reason Resonance has no walkie-talkie mode; licence-free FRS radios may also send data for only one second in thirty.

MIT licence.
