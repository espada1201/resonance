# Check-ins

One tap tells everyone in earshot "I'm safe" or "I need help", with a GPS fix if the browser allows it. Every station lists each person's latest check-in, with distance and direction once it knows its own position.

## Sub-features

- `checkin-safe` "I'm safe" reaches the other station's Safety tab and feed with the sender's name.
- `checkin-distance` with both positions known, the entry reads like `300 m N` and the feed like `300 m N of you · ±8 m`.
- `checkin-map` the Safety tab plots everyone with a position on a map around you.
- `checkin-name` someone with no name yet is offered a name box under the `I'm safe` / `I need help` buttons on the first screen and on the check-in card (both stay for the whole visit, with what was typed, also after leaving Safety and coming back); what they type becomes their nickname and the first send carries it. Nothing waits for it. Once named, the own row reads `You (Margaret)` and the header shows the name beside the id, also at 360 px. A check-in sent without one still goes at once, then reads `Others see you as #XXXXXX. Type your name in the box above, then send again.` and, after `I'm safe`, the name box is focused. After a call for help or medical check-in the keyboard stays on the details (`Where`, or the button that was pressed). The line stays until the next send, even once a name is typed.
- `checkin-shortcuts` the Feed tab has `I'm safe` and `I need help` above the feed; a tap opens Safety and does what that tab's own button does. Taps on Safety's own `I'm safe` / `I need help` in the first 400 ms after that are ignored, so a double tap sends one check-in.
- `checkin-take-back` after a one-tap `I need help` (Feed or Safety) `Sent by mistake? Take it back` sits just before `Where` (one Shift+Tab from it), or after the status line if the details are closed, and stays for that request after leaving Safety until it is closed, or for 10 minutes. It sends `resolved` with a mistake flag (one byte older phones ignore, so they show resolved) and reads `Taken back. Others now see it as cancelled: sent by mistake.` Both phones show `Cancelled: sent by mistake` in grey on the row and the feed card, without the red `Needs help` tag; the form goes back to Safe and closes. A later check-in removes the offer. The call itself is never held for a confirm.
- `checkin-no-fix` GPS never holds a check-in back more than about 3 s: with a location prompt nobody answers, `I need help` is on air within seconds; when GPS fails, the check-in still goes, with one calm grey line `Location not found yet — add where you are in words if you can.` (never red, never an alert, gone with the next send)
- `checkin-waiting` until a check-in has played on air, the card under the buttons reads `Waiting to send…`, not `Sent.` A phone whose screen locks mid-frame has not sent it: it stays waiting, a reload still sends it, and it goes once as soon as the phone's sound is back.

## How to get to it (user POV)

- Safety tab, `I'm safe` or `I need help`.
- Safety tab, `Use my position` to see distances.

## Driving it with verify.sh

Preconditions: the journey grants geolocation and moves the second station 300 m south.

- **Asked for a name.** Run `verify.sh drive e2e/safety.spec.ts 'a call for help travels'`. Ana joins without a nickname, types it in `Your name` on the Safety tab, and the other station's list shows `Ana`.

- **Sent without a name.** Run `verify.sh drive e2e/safety.spec.ts 'without a name'`. Both journeys: a nameless `I'm safe` and `I need help` go out, the prompt appears, and typing a name clears it.
- **First-screen buttons.** Run `verify.sh drive e2e/safety.spec.ts 'the first screen has'`. Run `'the first screen offers a name box'` and `'without a name still sends'`: a name typed there is on the other station's row after the first tap, and a tap without one still goes at once. `'says it opened Safety'`: `Opened Safety.` is said and the keyboard is never left on the page body while it sends.
- **Own name.** Run `verify.sh drive e2e/safety.spec.ts 'naming yourself'` (360 x 640): the row reads `You (Margaret)`, the header shows `Margaret` inside the screen, and the box is still there after Feed and back.
- **Take it back by keyboard.** Run `'one Shift+Tab from Where'`: one Shift+Tab from `Where` reaches the button, and it is still there after Feed and back; `'no longer offers'`: after `I got help` it is gone.
- **Taken back.** Run `verify.sh drive e2e/safety.spec.ts 'sent by mistake'` and `'same way out'`: the other station's row for Ana reads `Cancelled: sent by mistake`, not `Waiting for help` or `Needs help`, and its feed card says `took it back: sent by mistake`.
- **Double tap.** Run `verify.sh drive e2e/safety.spec.ts 'double tap'`. The page taps the Feed's `I need help` and Safety's `I'm safe` as soon as it can be pressed (inside 400 ms); only the call for help goes out.
- **Keyboard after help.** Run `verify.sh drive e2e/safety.spec.ts 'open form without a name'`.

- **Safe with a fix.** Run `verify.sh drive e2e/messaging.spec.ts "I'm safe reaches the other station"`. The other station's Safety list shows `Safe` and `300 m N`, the map is labelled `Map of 1 check-ins around you`, and its feed shows `300 m N of you · ±8 m`.

- **No fix.** Run `verify.sh drive e2e/safety.spec.ts 'location prompt waits'` and `verify.sh drive e2e/safety.spec.ts 'compose bar goes out without a position'`. The journeys stub GPS in the page: one never answers, one fails. Either way the station's own row appears and the air log shows `OUT check-in` within 8 s, with the calm line and no alert.

- **Waiting to send.** Run `verify.sh drive e2e/safety.spec.ts 'the big help button'`: under the buttons, `Waiting to send…` becomes `Sent. Nobody has answered yet.` once the check-in has played. Simulated air and Chromium's fake device never suspend their sound, so a screen locked mid-frame is driven on the station: `npx vitest run src/station.test.ts -t 'locked screen'`. Ten minutes locked, the check-in is still to go and nothing more is played; back on screen it goes on air once, and only then does its repeat timer start.

## Gotchas

- Without the geolocation permission, or with no fix within about 3 s, the check-in still goes out, without a position.
- Distances below 10 m read `right next to you`.
