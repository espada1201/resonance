# Notices

A notice tells everyone in earshot something that matters for a while: water at the gym, the bridge is out. It is pinned above every feed until it runs out, danger first, and the beacon shows it large across the room.

## Sub-features

- `notice-feed` a notice sent from a phone is pinned on the other station's feed with its place and `from <name>`.
- `notice-beacon` the beacon posts a notice signed with its `Sign as` name (`Beacon` until someone types another), and phones show it `from` that name.

## How to get to it (user POV)

- Feed tab, `Notice` in the `What to send` choice: a topic, the text, `Where`, `Show it for`, then `Send`.
- Beacon page, `Post a notice`.

## Driving it with verify.sh

Preconditions: none beyond the baseline.

- **From a phone.** Run `verify.sh drive e2e/safety.spec.ts 'a notice is pinned'`. The other station's `Notices` board shows the text, `Elm St school` and `from Desk`.
- **From the beacon.** Run `verify.sh drive e2e/safety.spec.ts 'a beacon at the shelter desk'`. `Sign as` starts as `Beacon`; the notice posted as `Front desk` shows `from Front desk` on the beacon and on the phone.

## Gotchas

- A notice runs from the time it was written, by the sender's clock, for 3 hours to 3 days.
- A newer notice from the same sender about the same topic and place replaces the earlier one.
