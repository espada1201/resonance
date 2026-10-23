# Messages

Anyone in earshot can post a message that every station shows, and send a message or a contact card to one neighbour, who answers with a receipt.

## Sub-features

- `message-broadcast` a message reaches every station in earshot and says it was heard directly.
- `message-direct` a message to one neighbour shows only there and comes back `delivered`.
- `message-contact` a contact card arrives with name, phone and note, and saves as a vCard.
- `message-reopen` what was still waiting to send when the page closed goes out when it opens again, a direct message still `waiting for receipt…`.
- `message-waiting` your own message reads `waiting to send…` until it has played whole, then a direct one `waiting for receipt…`; while the phone's sound is suspended (screen locked, a call), it waits for the sound to come back.

## How to get to it (user POV)

- Feed tab, `Message` in the `What to send` choice, type in the box, press `Send` or Enter.
- People tab, `Message <name> directly`, which selects that neighbour in the `To` menu.
- Feed tab, `Contact` in the `What to send` choice.

## Driving it with verify.sh

Preconditions: none beyond the baseline.

- **Broadcast.** Run `verify.sh drive e2e/messaging.spec.ts 'two stations trade messages'`. Each station's feed shows the other's text with `heard directly`.
- **Direct and receipt.** Run `verify.sh drive e2e/messaging.spec.ts 'a direct message shows only'`. The addressee shows it `direct to you`, the sender's item reads `delivered` (8 to 9 s after sending in 12 of 12 runs), and a third station that heard it never shows the text.
- **Contact card.** Run `verify.sh drive e2e/messaging.spec.ts 'a contact card arrives'`. The receiver's card links the phone as `tel:+442079460000`, and `Save contact` downloads `Dr Okafor.vcf` with the name and number.
- **Reopened page.** Simulated air keeps nothing between visits, so this one is driven on the station itself: `npx vitest run src/station.test.ts -t 'what still waited'`. The check-in airs twice and the direct message three times after the reload, and it reads `sending`, not `unknown`.
- **Waiting to send.** The direct journey above: the sender's item reads `waiting to send…` while its frame plays, before `delivered`. Simulated air never suspends its sound, so waiting for it is driven on the station, with a check-in: see [Check-ins](./check-ins.md).

## Gotchas

- A broadcast nobody echoes is sent again after 20 to 28 s, and once more if a neighbour is in earshot, so a copy that collides with a hello or a relay still arrives.
- A bystander waits one backoff window before repeating a direct message, so the addressee's receipt goes first and stands the repeat down. A `delivered` that takes about a minute means the first receipt was lost and the sender retried: look for `LOST` or a missing `IN ack` in the sender's air log.
- The `To` menu is disabled for check-ins, notices and files: those always go to everyone.
