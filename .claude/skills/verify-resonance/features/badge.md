# Open requests on the Safety tab

The Safety tab's name counts other people's requests for help still open, so whoever is on another tab sees that someone needs help. Your own call for help is not counted: it is nothing for you to act on. Nor is a request you have answered `On my way`; someone else's `On my way` does not remove it. The same count is in the page title and on the home-screen icon.

## Sub-features

- `badge-count` with one open request the tab shows `1`, and its name is `Safety, 1 waiting for you`.
- `badge-clears` once the person who asked checks in safe, the tab is plain `Safety` again.
- `badge-not-own` after your own `I need help`, your tab stays plain `Safety`, with no count and the title `Resonance`. The Safety heading says what is true in plain words and never says nobody is needed while a person waits: `1 person · 1 asking for help · you are waiting for someone` (and `someone is coming to you` once answered).
- `badge-answered` after you tap `On my way` on someone's request, the count goes (tab plain `Safety`, title `Resonance`) and the heading reads `1 person · 1 asking for help · you are on your way to 1`. The three states of the heading: `no one is asking for help`, `1 waiting for you` (not answered yet), `you are on your way to 1` (answered by you).

## How to get to it (user POV)

- The tab bar, from any tab.

## Driving it with verify.sh

Preconditions: none beyond the baseline.

- **Not your own.** Run `verify.sh drive e2e/safety.spec.ts 'one tap for help goes on air'`. Ana asks for help and her own tab shows no badge, and her heading says `you are waiting for someone`.
- **Count and clear.** Run `verify.sh drive e2e/safety.spec.ts 'a call for help travels'`. Ben's tab is named `Safety, 1 waiting for you` while Ana waits (heading `... · 1 asking for help · 1 waiting for you`), plain `Safety` once he taps `On my way` (heading `... · 1 asking for help · you are on your way to 1`), and the title is `Resonance` again with the heading `1 person · no one is asking for help` after she is safe.

## Gotchas

- A request with no news for a day stops counting.
- `openTab` in `e2e/helpers.ts` matches `Safety` with or without the count.
