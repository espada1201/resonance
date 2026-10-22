# Layout

Every tab renders with content and without sideways scrolling, on a laptop and on a phone, even when a stranger plays a message with an overlong nickname into the room.

## Sub-features

- `layout-wide` 1440 x 900, air log beside the tabs.
- `layout-phone` 390 x 844, air log behind its own tab.
- `layout-long-nickname` a message played into the room with a nickname longer than any phone sends stays inside its card, and the composer stays on screen.

## How to get to it (user POV)

- Any page, any window size.

## Driving it with verify.sh

Preconditions: none beyond the baseline.

- **Both sizes.** Run `verify.sh drive e2e/responsive.spec.ts 'every tab renders'`. Screenshots of each tab land in `e2e/.out/screens/`.
- **A stranger's long nickname.** Run `verify.sh drive e2e/responsive.spec.ts 'a nickname longer'`. A message with a 100-character nickname is played into the room; once it is in the feed, nothing scrolls sideways or sticks out of its box.

## Gotchas

- The journey also fails when any visible box in the main area is narrower than its content, so a card or control spilling out inside a scrolling panel is caught too. Text cut off on purpose with an ellipsis is allowed.
