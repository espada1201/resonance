# Open requests on the Safety tab

The Safety tab's name counts other people's requests for help still open, so whoever is on another tab sees that someone needs help. Your own call for help is not counted: it is nothing for you to act on. The same count is in the page title and on the home-screen icon.

## Sub-features

- `badge-count` with one open request the tab shows `1`, and its name is `Safety, 1 open request`.
- `badge-clears` once the person who asked checks in safe, the tab is plain `Safety` again.
- `badge-not-own` after your own `I need help`, your tab stays plain `Safety`, with no count and the title `Resonance`.

## How to get to it (user POV)

- The tab bar, from any tab.

## Driving it with verify.sh

Preconditions: none beyond the baseline.

- **Not your own.** Run `verify.sh drive e2e/safety.spec.ts 'one tap for help goes on air'`. Ana asks for help and her own tab shows no badge.
- **Count and clear.** Run `verify.sh drive e2e/safety.spec.ts 'a call for help'`. Ben's tab is named `Safety, 1 open request` while Ana waits, and `Safety` once she is safe.

## Gotchas

- A request with no news for a day stops counting.
- `openTab` in `e2e/helpers.ts` matches `Safety` with or without the count.
