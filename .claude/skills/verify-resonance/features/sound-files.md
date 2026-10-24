# Sound files

Any packet can leave as a WAV file that any speaker can play to the mesh, and a recording that caught Resonance chirps can be decoded back into packets.

## Sub-features

- `sound-export` `Save as audio` on a feed item downloads a WAV of that packet.
- `sound-import` `Open an audio file` in Settings reads the messages in a recording and adds new ones to the feed.

## How to get to it (user POV)

- Feed tab, `Save as audio` under a message.
- Settings tab, `Read a recording`, `Open an audio file`.

## Driving it with verify.sh

Preconditions: none beyond the baseline.

- **Export and import.** Run `verify.sh drive e2e/sound-files.spec.ts`. The sender downloads `resonance-<id>-<msg>.wav`, closes, and a new station that never heard the message decodes the file: `Found 1 packet. New ones are in your feed.`, and the message is in its feed.

## Gotchas

- Phone calls, voicemail and walkie-talkies cut the tones, so a WAV sent through them will not decode.
- A device keeps packets for a while (messages 12 hours, check-ins, replies and notices 3 days, 300 at most), and the feed shows older items. On an item whose packet is gone, `Save as audio` says `This device no longer keeps this packet, so it cannot be saved as sound.` No journey ages a packet out; a unit test in `src/ui/feed.test.ts` covers it.
