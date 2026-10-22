# Offline

After one visit the service worker has cached the app, so it opens with no network at all, the beacon page too.

## Sub-features

- `offline-app` the phone app reloads with the network off and `Start listening` is enabled.
- `offline-beacon` the beacon page opens with the network off.

## How to get to it (user POV)

- Open the app once while online, then open it again anywhere.

## Driving it with verify.sh

Preconditions: none beyond the baseline.

- **Both pages.** Run `verify.sh drive e2e/offline.spec.ts 'opens with no network'`. Both headings render from the cache while the service worker itself cannot reach the network.

## Gotchas

- Plain Playwright offline mode does not reach service workers. The spec sets the flag that makes the worker offline too, so a cache miss fails.
