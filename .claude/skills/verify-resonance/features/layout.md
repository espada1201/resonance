# Layout

Every tab renders with content and without sideways scrolling, on a laptop and on a phone.

## Sub-features

- `layout-wide` 1440 x 900, air log beside the tabs.
- `layout-phone` 390 x 844, air log behind its own tab.

## How to get to it (user POV)

- Any page, any window size.

## Driving it with verify.sh

Preconditions: none beyond the baseline.

- **Both sizes.** Run `verify.sh drive e2e/responsive.spec.ts 'every tab renders'`. Screenshots of each tab land in `e2e/.out/screens/`.

## Gotchas

- The check covers the page's own width. A card that overflows inside a scrolling panel needs its own assertion.
