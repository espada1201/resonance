# Find

Two devices time chirps both ways to measure the distance between them, with no clock sync and no GPS.

## Sub-features

- `find-distance` choosing `Find` next to a neighbour shows the distance in metres.

## How to get to it (user POV)

- People tab, `Find <name>: measure the distance by sound`.

## Driving it with verify.sh

Preconditions: the journey places the two tabs 3.2 m apart with `&at=`.

- **Distance.** Run `verify.sh drive e2e/find.spec.ts 'Find measures the distance'`. The `Distance to` region reads between 3.00 and 3.40 m.

## Gotchas

- The neighbour must have `Answer distance requests` on (the default).
