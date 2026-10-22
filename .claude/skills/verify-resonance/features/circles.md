# Circles

Everyone who types the same passphrase can read what the others in the circle send. Everyone else relays it but sees only that it is sealed.

## Sub-features

- `circle-seal` a member's message shows in full for another member, marked `circle`.
- `circle-outsider` a station with no passphrase or another one shows `Sealed for a circle you are not in` and never the text.
- `circle-late` a sealed message heard before joining opens where it lies once the right passphrase is applied, and a sealed file heard before joining appears whole.

## How to get to it (user POV)

- Settings tab, `Circle passphrase`, then `Apply`.

## Driving it with verify.sh

Preconditions: none beyond the baseline.

- **Seal and outsiders.** Run `verify.sh drive e2e/messaging.spec.ts 'a circle passphrase seals'`. Station b shows the secret with `circle`; stations c and d show the sealed notice and the secret appears nowhere on their pages.
- **Joining late.** Run `verify.sh drive e2e/safety.spec.ts 'heard before joining the circle'`. Station b, first in the wrong circle, shows `Sealed for a circle you are not in` and no item for the file whose chunks its air log shows arriving; after applying the right passphrase its feed shows `Meet at the library`, `route.txt` with `Save file`, and no sealed item.

## Gotchas

- Deriving the key takes a moment (PBKDF2, 600,000 rounds). Wait for the settings line `are sealed with AES-256-GCM` before sending. After a reload, anything sent waits for the key to be made again, and where it cannot be made (a plain http page) sending is refused with `Your circle could not be joined in this browser`, never done in the open. Proved by the unit tests `after a reload, says nothing until the circle key` and `refuses to say anything in the open` in src/station.test.ts.
- A sealed file's chunks make no feed item until the circle is joined: look for `file chunk from` in the air log.
- Encryption needs a secure page. `localhost` counts; a LAN address over plain http does not.
