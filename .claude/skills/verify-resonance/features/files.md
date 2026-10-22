# Tiny files

A file up to 4 KB, or a photo shrunk to fit, crosses the air in chunks. Receivers show progress, ask for missing pieces, and offer the file once it is whole.

## Sub-features

- `file-send` the sender picks a file and sees its name and size before sending.
- `file-receive` the receiver gets `Save file` and the download is byte for byte the original.

## How to get to it (user POV)

- Feed tab, `Tiny file`, `Choose a file or photo`, then `Send`.

## Driving it with verify.sh

Preconditions: none beyond the baseline.

- **Send and save.** Run `verify.sh drive e2e/messaging.spec.ts 'a tiny file crosses the air'`. The receiver's `Save file` link downloads `shelters.txt` with identical bytes.

## Gotchas

- A 300-byte file is three chunks and takes a minute or more on audible air. The journey allows 200 s.
