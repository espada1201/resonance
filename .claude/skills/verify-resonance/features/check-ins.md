# Check-ins

One tap tells everyone in earshot "I'm safe" or "I need help", with a GPS fix if the browser allows it. Every station lists each person's latest check-in, with distance and direction once it knows its own position.

## Sub-features

- `checkin-safe` "I'm safe" reaches the other station's Safety tab and feed with the sender's name.
- `checkin-distance` with both positions known, the entry reads like `300 m N` and the feed like `300 m N of you · ±8 m`.
- `checkin-map` the Safety tab plots everyone with a position on a map around you.

## How to get to it (user POV)

- Safety tab, `I'm safe` or `I need help`.
- Safety tab, `Use my position` to see distances.

## Driving it with verify.sh

Preconditions: the journey grants geolocation and moves the second station 300 m south.

- **Safe with a fix.** Run `verify.sh drive e2e/messaging.spec.ts "I'm safe reaches the other station"`. The other station's Safety list shows `Safe` and `300 m N`, the map is labelled `Map of 1 check-ins around you`, and its feed shows `300 m N of you · ±8 m`.

## Gotchas

- Without the geolocation permission the check-in still goes out, without a position.
- Distances below 10 m read `right next to you`.
