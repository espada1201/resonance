# Beacon

A laptop opened on the beacon page listens all the time, repeats everything it hears, and hands what it holds to every phone that comes within earshot.

## Sub-features

- `beacon-relay` the beacon hears a phone's message, relays it, and the phone hears its own message come back.
- `beacon-stats` the beacon's `Heard` and `Relayed` counts go up.

## How to get to it (user POV)

- Settings tab, `Open beacon mode`, or open `/beacon.html` directly.

## Driving it with verify.sh

Preconditions: none beyond the baseline.

- **Relay.** Run `verify.sh drive e2e/beacon.spec.ts 'a beacon hears a phone'`. The beacon's air log shows the message in and `message relayed for <id>` out, its counts rise, and the phone's log shows `echo of your message`.

## Gotchas

- The beacon page has no compose box. Send from a phone tab.
