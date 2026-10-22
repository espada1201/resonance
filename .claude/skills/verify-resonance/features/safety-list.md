# Safety list and replies

A call for help carries what is needed and where. Every station lists each person's latest check-in, open requests first, and anyone can answer `On my way` or mark a request resolved, while the person who asked sees who is coming. People without a phone can be checked in by someone else. The list can be searched, printed and downloaded as a spreadsheet.

## Sub-features

- `safety-request` a check-in asking for help reaches the other station with its needs and place, and its row reads `Waiting for help`.
- `safety-reply` `On my way` reads `You are on the way` on the responder's row and `Ben is on the way` on the asker's. The asker's next `I'm safe` closes the request.
- `safety-someone-else` a check-in for someone without a phone is listed under their name, `reported by` the sender.
- `safety-search` the search box finds a name typed without its accents.
- `safety-spreadsheet` `Spreadsheet` downloads a CSV with a header row and one row per person.

## How to get to it (user POV)

- Safety tab, `More detail`, then a status, what is needed, `Where`, and `Send check-in`.
- Safety tab, under an open request: `On my way`, and `Resolved` (`I got help` on your own request).
- Safety tab, `More detail`, `For someone without a phone`, `Their name`.
- Safety tab, `Search check-ins`, `Spreadsheet`, `Print`.

## Driving it with verify.sh

Preconditions: none beyond the baseline.

- **Request and answer.** Run `verify.sh drive e2e/safety.spec.ts 'a call for help'`. Ben's row for Ana shows `Waiting for help`, `Trapped` and `Floor 4, room 412`. After `On my way`, Ana's own row shows `Ben is on the way`; after her `I'm safe`, Ben's row shows `Safe` and no longer `Waiting for help`.
- **Someone without a phone, search and spreadsheet.** Run `verify.sh drive e2e/safety.spec.ts 'the safety list downloads'`. The other station lists `María López` `reported by Ana`, the search `maria` still finds her, and the CSV holds `María López,Ana,Safe,`.

## Gotchas

- A request with no news for a day reads `No news for a day` and stops counting as open.
- A reply is sealed exactly when its check-in was. Answering a circle's request after leaving the circle shows `Join the circle again to answer this.`
- The list keeps three days of check-ins, replies and notices, longer than the feed, which keeps only its newest 400 items.
