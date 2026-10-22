# Circles

Everyone who types the same passphrase can read what the others in the circle send. Everyone else relays it but sees only that it is sealed.

## Sub-features

- `circle-seal` a member's message shows in full for another member, marked `circle`.
- `circle-outsider` a station with no passphrase or another one shows `Sealed for a circle you are not in` and never the text.
- `circle-late` a sealed message heard before joining opens where it lies once the right passphrase is applied.

## How to get to it (user POV)

- Settings tab, `Circle passphrase`, then `Apply`.

## Driving it with verify.sh

Preconditions: none beyond the baseline.

- **Seal and outsiders.** Run `verify.sh drive e2e/messaging.spec.ts 'a circle passphrase seals'`. Station b shows the secret with `circle`; stations c and d show the sealed notice and the secret appears nowhere on their pages.
- **Joining late.** Run `verify.sh drive e2e/safety.spec.ts 'a sealed message heard before joining'`. Station b, first in the wrong circle, shows `Sealed for a circle you are not in`; after applying the right passphrase its feed shows `Meet at the library` and no sealed item.

## Gotchas

- Deriving the key takes a moment (PBKDF2, 600,000 rounds). Wait for the settings line `are sealed with AES-256-GCM` before sending.
- Only messages, check-ins, replies, notices and contact cards open on joining. A file heard sealed before joining stays sealed.
- Encryption needs a secure page. `localhost` counts; a LAN address over plain http does not.
