# Messages

Anyone in earshot can post a message that every station shows, and send a message or a contact card to one neighbour, who answers with a receipt.

## Sub-features

- `message-broadcast` a message reaches every station in earshot and says it was heard directly.
- `message-direct` a message to one neighbour shows only there and comes back `delivered`.
- `message-contact` a contact card arrives with name, phone and what its owner can help with, and saves as a vCard.

## How to get to it (user POV)

- Feed tab, `Message` in the `What to send` choice, type in the box, press `Send` or Enter.
- People tab, `Message <name> directly`, which selects that neighbour in the `To` menu.
- Feed tab, `Contact` in the `What to send` choice.

## Driving it with verify.sh

Preconditions: none beyond the baseline.

- **Broadcast.** Run `verify.sh drive e2e/messaging.spec.ts 'two stations trade messages'`. Each station's feed shows the other's text with `heard directly`.
- **Direct and receipt.** No journey yet. Report `message-direct` as not verified.
- **Contact card.** No journey yet. Report `message-contact` as not verified.

## Gotchas

- A broadcast nobody echoes is sent again after 20 to 28 s, so the first copy can collide with a hello and still arrive.
- The `To` menu is disabled for check-ins, notices and files: those always go to everyone.
