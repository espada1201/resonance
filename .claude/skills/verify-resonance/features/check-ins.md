# Check-ins

One tap tells everyone in earshot "I'm safe" or "I need help", with a GPS fix if the browser allows it. Every station lists each person's latest check-in, with distance and direction once it knows its own position.

## Sub-features

- `checkin-safe` "I'm safe" reaches the other station's Safety tab and feed with the sender's name.
- `checkin-distance` with both positions known, the entry reads like `300 m N` and the feed like `300 m N of you · ±8 m`.
- `checkin-map` the Safety tab plots everyone with a position on a map around you.
- `checkin-name` someone with no name yet is asked for one on the check-in card and in the compose bar's check-in; what they type becomes their nickname.
- `checkin-no-fix` GPS never holds a check-in back more than about 3 s: with a location prompt nobody answers, `I need help` is on air within seconds; when GPS fails, the compose bar's check-in still goes, saying `Sent without a position.`
- `checkin-waiting` until a check-in has played on air, the card under the buttons reads `Waiting to go on air…`, not `Sent.` A phone whose screen locks mid-frame has not sent it: it stays waiting, a reload still sends it, and it goes once as soon as the phone's sound is back.

## How to get to it (user POV)

- Safety tab, `I'm safe` or `I need help`.
- Safety tab, `Use my position` to see distances.

## Driving it with verify.sh

Preconditions: the journey grants geolocation and moves the second station 300 m south.

- **Asked for a name.** Run `verify.sh drive e2e/safety.spec.ts 'a call for help travels'`. Ana joins without a nickname, types it in `Your name` on the Safety tab, and the other station's list shows `Ana`.

- **Safe with a fix.** Run `verify.sh drive e2e/messaging.spec.ts "I'm safe reaches the other station"`. The other station's Safety list shows `Safe` and `300 m N`, the map is labelled `Map of 1 check-ins around you`, and its feed shows `300 m N of you · ±8 m`.

- **No fix.** Run `verify.sh drive e2e/safety.spec.ts 'location prompt waits'` and `verify.sh drive e2e/safety.spec.ts 'compose bar goes out without a position'`. The journeys stub GPS in the page: one never answers, one fails. Either way the station's own row appears and the air log shows `OUT check-in` within 8 s.

- **Waiting to go on air.** Run `verify.sh drive e2e/safety.spec.ts 'the big help button'`: under the buttons, `Waiting to go on air…` becomes `Sent. Nobody has answered yet.` once the check-in has played. Simulated air and Chromium's fake device never suspend their sound, so a screen locked mid-frame is driven on the station: `npx vitest run src/station.test.ts -t 'locked screen'`. Ten minutes locked, the check-in is still to go and nothing more is played; back on screen it goes on air once, and only then does its repeat timer start.

## Gotchas

- Without the geolocation permission, or with no fix within about 3 s, the check-in still goes out, without a position.
- Distances below 10 m read `right next to you`.
