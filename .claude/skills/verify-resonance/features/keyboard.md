# Keyboard hints

Tabs and the list of needs follow the standard arrow-key pattern, and a short line names the arrow keys while the keyboard is on them. A touch or mouse user never sees it.

## Sub-features

- `keyboard-tabs-hint` with the keyboard on a tab, `Arrow keys switch tabs` shows in its own line under the tab row, pushing the page down by that line instead of covering the top of it (checked at 360 and 1280 px); moving along the tabs moves nothing more. After a click it stays hidden.
- `keyboard-shortcut-focus` a first-screen `I'm safe` / `I need help` opens Safety, says `Opened Safety.` in a polite live region, and puts the keyboard on the Safety tab at once (never on the page), then on the button or field that follows the send.
- `keyboard-needs-hint` with the keyboard on a need, `Arrow keys move, Space picks` shows beside `What is needed?`; it is gone once focus moves on.

## How to get to it (user POV)

- Press Tab to reach the tab row, or the needs under `Needs help` in a check-in, then an arrow key.

## Driving it with verify.sh

Preconditions: none beyond the baseline.

- **Tabs.** Run `verify.sh drive e2e/start.spec.ts 'arrow keys switch tabs'`.
- **Not covering the page.** Run `verify.sh drive e2e/start.spec.ts 'keyboard hint at'`. With the keyboard on Feed, Safety and Settings, the hint ends above the tab panel and above its first content, inside the page, at 360 and 1280 px.
- **Needs.** Run `verify.sh drive e2e/safety.spec.ts 'keyboard meets its fields'`.

## Gotchas

- The hint follows `:focus-visible`: a script's `focus()` after a mouse click does not show it. The journeys press a real key first.
