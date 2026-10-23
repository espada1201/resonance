# Signal

Each station says, in plain words, how well it hears every neighbour, judged from the frames that neighbour sent itself. The air panel opens with one line on who is heard directly and what to do about a weak link.

## Sub-features

- `signal-people` People rates each neighbour heard directly `Strong signal`, `Fair signal` or `Weak signal`, with the mode it uses.
- `signal-air` the air panel's first line reads like `Hearing Ana (strong, Audible).`

## How to get to it (user POV)

- People tab, `Heard directly`.
- The air panel: beside the tabs on a laptop, the `Sound` tab on a phone.

## Driving it with verify.sh

Preconditions: none beyond the baseline.

- **Both.** Run `verify.sh drive e2e/safety.spec.ts 'People rates each neighbour'`. Ana's row on Ben's People tab reads `Strong signal · Audible` (or Fair, or Weak), and his air panel reads `Hearing Ana (strong, Audible).`

## Gotchas

- A neighbour that said hello before you arrived stays unrated until it sends again: relayed frames and recordings say nothing about the path between two stations.
- Ratings live in memory, so a reload starts them over.
