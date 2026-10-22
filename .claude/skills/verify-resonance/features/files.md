# Tiny files

A file up to 4 KB, or a photo shrunk to fit, crosses the air in chunks. Receivers show progress, ask for missing pieces, and offer the file once it is whole.

## Sub-features

- `file-send` the sender picks a file and sees its name and size before sending.
- `file-receive` the receiver gets `Save file` and the download is byte for byte the original.
- `file-photo-preview` a picked photo shows a preview, and picking another lets go of the first one's.

## How to get to it (user POV)

- Feed tab, `Tiny file`, `Choose a file or photo`, then `Send`.

## Driving it with verify.sh

Preconditions: none beyond the baseline.

- **Send and save.** Run `verify.sh drive e2e/messaging.spec.ts 'a tiny file crosses the air'`. The receiver's `Save file` link downloads `shelters.txt` with identical bytes.
- **Photo preview.** Run `verify.sh drive e2e/files.spec.ts 'picking another photo'`. After a second photo is picked, the first preview's address is the only one revoked.

## Gotchas

- A 300-byte file is three chunks and takes a minute or more on audible air. The journey allows 200 s.
