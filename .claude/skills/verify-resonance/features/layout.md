# Layout

Every tab renders with content and without sideways scrolling, on a laptop and on a phone, even when a stranger plays a message with an overlong nickname into the room.

## Sub-features

- `layout-wide` 1440 x 900, air log beside the tabs.
- `layout-phone` 390 x 844, air log behind its own tab.
- `layout-tab-row` at 360 and 320 px all five tab labels (with a count on Safety) are whole inside the tab row, which does not scroll sideways.
- `layout-first-screen` at 360 x 640 `I'm safe` and `I need help` (44 px tall), some feed and the message box all fit.
- `layout-long-nickname` a message played into the room with a nickname longer than any phone sends stays inside its card, and the composer stays on screen.

## How to get to it (user POV)

- Any page, any window size.

## Driving it with verify.sh

Preconditions: none beyond the baseline.

- **Both sizes.** Run `verify.sh drive e2e/responsive.spec.ts 'every tab renders'`. Screenshots of each tab land in `e2e/.out/screens/`.
- **Tab row.** Run `verify.sh drive e2e/responsive.spec.ts 'tab row at'`. A check-in is played in so Safety carries its count; every tab label is whole.
- **First screen.** Run `verify.sh drive e2e/responsive.spec.ts 'first screen on a 360x640'`.
- **A stranger's long nickname.** Run `verify.sh drive e2e/responsive.spec.ts 'a nickname longer'`. A message with a 100-character nickname is played into the room; once it is in the feed, nothing scrolls sideways or sticks out of its box.

## Gotchas

- The journey also fails when any visible box in the main area is narrower than its content, so a card or control spilling out inside a scrolling panel is caught too. Text cut off on purpose with an ellipsis is allowed.
