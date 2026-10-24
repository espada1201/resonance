# Beacon

A laptop opened on the beacon page listens all the time, repeats everything it hears, and hands what it holds to every phone that comes within earshot.

## Sub-features

- `beacon-relay` the beacon hears a phone's message, relays it, and the phone hears its own message come back.
- `beacon-stats` the beacon's `Heard` and `Relayed` counts go up.
- `beacon-desk` the beacon lists who checked in, open requests first, and posts notices signed with its `Sign as` name.

## How to get to it (user POV)

- Settings tab, `Open beacon mode`, or open `/beacon.html` directly.

## Driving it with verify.sh

Preconditions: none beyond the baseline.

- **Relay.** Run `verify.sh drive e2e/beacon.spec.ts 'a beacon hears a phone'`. The beacon's air log shows the message in and `message relayed for <id>` out, its counts rise, and the phone's log shows `echo of your message`.
- **Desk.** Run `verify.sh drive e2e/safety.spec.ts 'a beacon at the shelter desk'`. The beacon's notice signed `Front desk` reaches the phone, and the phone's `I need help` appears on the beacon as `Waiting for help` under `Check-ins · 1 person · 1 asking for help`.

## Gotchas

- The beacon page sends only notices. Send messages and check-ins from a phone tab.
- Its list is for reading across a room: answer requests from a phone.
- It holds 300 packets. Once check-ins, replies and notices fill their share, it first lets go of a check-in that a later one from the same phone about the same person replaced, unless a reply answers it, so someone who checked in once is still handed on while others check in again and again. A sealed check-in is never taken as replaced. Proved by the unit tests `a full store forgets check-ins that later ones replaced`, `a full store never counts as replaced` and `an older check-in carried in late` in src/mesh/mesh.test.ts.
