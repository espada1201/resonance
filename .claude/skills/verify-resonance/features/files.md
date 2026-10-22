# Tiny files

A file up to 4 KB, or a photo shrunk to fit, crosses the air in chunks. Receivers show progress, ask for missing pieces, and offer the file once it is whole. A picture is shown as itself unless its header asks for more pixels than a phone should decode; anything bigger than a sender may send is dropped on arrival.

## Sub-features

- `file-send` the sender picks a file and sees its name and size before sending.
- `file-receive` the receiver gets `Save file` and the download is byte for byte the original.
- `file-photo-preview` a picked photo shows a preview, and picking another lets go of the first one's.
- `file-picture-received` a received picture is drawn; one whose header declares more than about 2 megapixels (1920 x 1080) or a side over 4096 px says `Too large to preview.` and keeps `Save file`.

## How to get to it (user POV)

- Feed tab, `Tiny file`, `Choose a file or photo`, then `Send`.

## Driving it with verify.sh

Preconditions: none beyond the baseline.

- **Send and save.** Run `verify.sh drive e2e/messaging.spec.ts 'a tiny file crosses the air'`. The receiver's `Save file` link downloads `shelters.txt` with identical bytes.
- **Photo preview.** Run `verify.sh drive e2e/files.spec.ts 'picking another photo'`. After a second photo is picked, the first preview's address is the only one revoked.
- **Pictures heard.** Run `verify.sh drive e2e/files.spec.ts 'a picture heard over the air'`. Two files are played into the room piece by piece: a 1×1 PNG shows as a picture, and a 25-byte WebP whose header declares 16383 x 16383 pixels says `Too large to preview.`, draws nothing and keeps `Save file`.

## Gotchas

- A 300-byte file is three chunks and takes a minute or more on audible air. The journey allows 200 s.
- The size comes from the header, whatever type the file claims: a file labelled as a picture whose header is not a PNG, JPEG, GIF or WebP is not drawn, and says nothing.
- A piece declaring a file over 4 KB, or more than 27 pieces, is dropped on arrival: no item appears. Files saved before that rule still load; an oversized picture among them is not drawn.
