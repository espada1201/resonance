# Circles

Everyone who types the same passphrase can read what the others in the circle send. Everyone else relays it but sees only that it is sealed.

## Sub-features

- `circle-seal` a member's message shows in full for another member, marked `circle`.
- `circle-outsider` a station with no passphrase or another one shows `Sealed for a circle you are not in` and never the text.

## How to get to it (user POV)

- Settings tab, `Circle passphrase`, then `Apply`.

## Driving it with verify.sh

Preconditions: none beyond the baseline.

- **Seal and outsiders.** Run `verify.sh drive e2e/messaging.spec.ts 'a circle passphrase seals'`. Station b shows the secret with `circle`; stations c and d show the sealed notice and the secret appears nowhere on their pages.

## Gotchas

- Deriving the key takes a moment (PBKDF2, 600,000 rounds). Wait for the settings line `are sealed with AES-256-GCM` before sending.
- Encryption needs a secure page. `localhost` counts; a LAN address over plain http does not.
