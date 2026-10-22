# Resonance verification map

This directory is the maintained source for verifying what Resonance users can do. Read this index, then use the matching feature file as the recipe. A feature is verified when every sub-feature in its file has a passing journey and its evidence exists.

## Baseline preconditions

- An instance launched by `verify.sh launch` and passing `verify.sh doctor`.
- Each journey opens its own browser context, so storage starts empty and nothing needs seeding.
- Never drive an instance this run did not start.

## Driving conventions

- Drive through `verify.sh drive <spec> '<test title>'`.
- Locate by role and accessible name. The specs never use CSS selectors for user actions.
- Stations join with `joinAir`, which waits until their first hello has cleared the air.
- Narrow layouts (under 960 px) move the air log behind an `Air` tab. `joinAir` handles it.

## Proof and skip reporting

- The journey asserts on the receiving station as well as the sender.
- `proof()` writes a screenshot and the accessibility tree to `e2e/.out/verify/<spec>/`.
- A sub-feature with no journey is reported as not verified, with the reason. Never count it as verified through another path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph on the user-visible behaviour, then four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with verify.sh`, `Gotchas`. Implementation details stay out.

## Features

- [Messages](./messages.md): broadcast and direct messages, receipts, contact cards.
- [Check-ins](./check-ins.md): "I'm safe" and "I need help" with a GPS fix, the list of who checked in.
- [Circles](./circles.md): a shared passphrase seals messages from everyone outside it.
- [Tiny files](./files.md): a small file or photo crosses the air in chunks.
- [Find](./find.md): two devices measure the distance between them by sound.
- [Beacon](./beacon.md): a laptop left in a hallway relays and remembers.
- [Microphone](./microphone.md): the real capture path decodes all three modes.
- [Sound files](./sound-files.md): save a packet as a WAV, decode packets from a recording.
- [Offline](./offline.md): the app and the beacon open with no network.
- [Layout](./layout.md): every tab fits a phone screen.
