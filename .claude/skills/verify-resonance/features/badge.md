# Open requests on the Safety tab

The Safety tab's name counts the requests for help still open, so whoever is on another tab sees that someone needs help.

## Sub-features

- `badge-count` with one open request the tab shows `1`, and its name is `Safety, 1 open request`.
- `badge-clears` once the person who asked checks in safe, the tab is plain `Safety` again.

## How to get to it (user POV)

- The tab bar, from any tab.

## Driving it with verify.sh

Preconditions: none beyond the baseline.

- **Count and clear.** Run `verify.sh drive e2e/safety.spec.ts 'a call for help'`. Ben's tab is named `Safety, 1 open request` while Ana waits, and `Safety` once she is safe.

## Gotchas

- A request with no news for a day stops counting.
- `openTab` in `e2e/helpers.ts` matches `Safety` with or without the count.
