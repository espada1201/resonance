# Courier to family outside

A check-in can carry a phone number or email address of someone outside. Every station lists the ones nobody has passed on yet. A phone that gets signal opens its own text or mail app with the message filled in, and `I sent it` tells everyone, so nobody sends it twice. The next one-tap check-in carries the same contact.

## Sub-features

- `courier-link` the other station offers `Send as text`, an `sms:` link holding the number and the message.
- `courier-passed` `I sent it` reads `You passed it on` there and `Ben passed it on` on the sender's station.
- `courier-remembered` the sender's Safety tab says its one-tap check-ins will carry the same contact.

## How to get to it (user POV)

- Safety tab, `More detail`, `Family outside: phone or email`, then `Send check-in`.
- Safety tab, `Pass on to family outside`, then `Send as text` or `Send as email`, then `I sent it`.

## Driving it with verify.sh

Preconditions: none beyond the baseline.

- **Pass it on.** Run `verify.sh drive e2e/safety.spec.ts 'a phone with signal passes'`. Ben's `Send as text` link starts `sms:+15550100100?&body=Ana%20is%20safe.`; after `I sent it`, Ana's list says `Ben passed it on` and her Safety tab says `Whoever gets signal first can tell +1 (555) 010-0100.`

## Gotchas

- Nothing leaves the phone until the person taps Send in their own app. `I sent it` only tells the mesh.
- Everyone who carries the check-in can read the contact, unless a circle seals it.
