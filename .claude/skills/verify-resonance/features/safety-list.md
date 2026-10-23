# Safety list and replies

A call for help carries what is needed and where. Every station lists each person's latest check-in, open requests first, right under the check-in buttons, and anyone can answer `On my way` or mark a request resolved, while the person who asked sees who is coming. People without a phone can be checked in by someone else. The list can be searched, printed and downloaded as a spreadsheet.

## Sub-features

- `safety-request` a check-in asking for help reaches the other station with its needs and place, and its row reads `Waiting for help`. The status choices read `Safe`, `Needs help`, `Needs medical help` and `Sheltering`.
- `safety-big-button` with `More detail` open, the big `I need help` sends what the form says (needs, note), and under the buttons reads `Waiting to send…` until it has played, `Sent. Nobody has answered yet.` until someone answers, then `Sent. Ben is on the way.`
- `safety-reply` `On my way` reads `You are on the way` on the responder's row and `Ben is on the way` on the asker's, whose own row never says `heard directly`. The responder's own line adds `sent, no other phone has passed it on yet`, then `another phone has it` once another phone is heard repeating the reply (`reply-receipt`, on the Feed card and the Safety row). The asker's next `I'm safe` closes the request.
- `safety-first-screen` on a 390 x 844 phone, the first person in the list is on the first screen, above the cards for family outside.
- `safety-someone-else` a check-in for someone without a phone is listed under their name, `reported by` the sender.
- `safety-search` the search box finds a name typed without its accents.
- `safety-spreadsheet` `Spreadsheet` downloads a CSV with a header row and one row per person.

## How to get to it (user POV)

- Safety tab, `More detail`, then a status, what is needed, `Where`, and `Send check-in` or the big `I need help`.
- Safety tab, under an open request: `On my way`, and `Resolved` then `Yes, resolved` (`I got help` on your own request, one tap).
- Safety tab, `More detail`, `For someone without a phone`, `Their name`.
- Safety tab, `Search check-ins`, `Spreadsheet`, `Print`.

## Driving it with verify.sh

Preconditions: none beyond the baseline.

- **Request and answer.** Run `verify.sh drive e2e/safety.spec.ts 'a call for help'`. While Ben reads the feed, his page title turns `(1) Resonance`, his phone buzzes once and screen readers hear `Needs help: Ana`; the title is `Resonance` again once she is safe. Ben's row for Ana shows `Waiting for help`, `Trapped` and `Floor 4, room 412`. After `On my way`, Ana's own row shows `Ben is on the way` and not `heard directly`. Ben's `Resolved` asks `Resolved for everyone?` with `Not yet` focused; `Not yet` leaves `Help on the way`, and `Yes, resolved` shows `Resolved` on Ana's row. After her `I'm safe`, Ben's row shows `Safe` and no longer `Waiting for help`.
- **Big button with the form open.** Run `verify.sh drive e2e/safety.spec.ts 'the big help button'`. Both stations' rows for Ana show `Trapped` and `Leg stuck under a beam`, her form is empty again, and under her buttons `Waiting to send…` becomes `Sent. Nobody has answered yet.`, then `Sent. Ben is on the way.`
- **First screen on a phone.** Run `verify.sh drive e2e/safety.spec.ts 'who needs help is on the first screen'`. With two cards for family outside, Ben's open request is wholly on Ana's first screen.
- **Someone without a phone, search and spreadsheet.** Run `verify.sh drive e2e/safety.spec.ts 'the safety list downloads'`. The other station lists `María López` `reported by Ana`, the search `maria` still finds her, and the CSV holds `María López,Ana,Safe,`.

## Gotchas

- A request with no news for a day reads `No news for a day` and stops counting as open.
- Asking again keeps a request's place in the list (it is ordered by the first ask still open). A `Resolved` closes the ask it answers and the ones before it, whatever either phone's clock says; an ask after it stays open and is queued from that ask. Proved by the unit tests in src/roster.test.ts (`keeps your place`, `opens a request again`, `whatever the clock`, `asked again after it was resolved`).
- Someone checked in by others gets one entry per reporter, so one person's `safe` for a name never hides another's request for that name.
- A date from the future counts from when the check-in, reply or notice arrived, so a forged or wrong clock cannot pin an entry for good.
- How old a request is goes by its arrival when heard from the asker's own phone, so a phone whose clock was reset is not `No news for a day` on arrival (`goes by arrival` in src/roster.test.ts). Passed along, it goes by the asker's clock.
- A reply is sealed exactly when its check-in was. Answering a circle's request after leaving the circle shows `Join the circle again to answer this.`
- The list keeps three days of check-ins, replies and notices, longer than the feed, which keeps only its newest 400 items.
