# Find

Two devices time chirps both ways to measure the distance between them, with no clock sync and no GPS.

## Sub-features

- `find-distance` choosing `Find` next to a neighbour shows the distance in metres.
- `find-in-entry` `Find` under someone's open request on the Safety tab shows the readout inside their entry.

## How to get to it (user POV)

- People tab, `Find <name>: measure the distance by sound`.
- Safety tab, `Find` under an open request from a device heard in the last 10 minutes.

## Driving it with verify.sh

Preconditions: the journey places the two tabs 3.2 m apart with `&at=`.

- **Distance.** Run `verify.sh drive e2e/find.spec.ts 'Find measures the distance'`. The `Distance to` region reads between 3.00 and 3.40 m.
- **In the entry.** Run `verify.sh drive e2e/safety.spec.ts 'who needs help is on the first screen'`. After `Find` on Ben's request, the `Distance to Ben` region is inside his entry.

## Gotchas

- The neighbour must have `Answer distance requests` on (the default).
