# Offline

After one visit the service worker has cached the app, so it opens with no network at all, the beacon page too. A page left open while a new version is published keeps its own version, so `Start listening` still works there, online or off. The new version takes over once every page of the app has been closed.

## Sub-features

- `offline-app` the phone app reloads with the network off and `Start listening` is enabled.
- `offline-beacon` the beacon page opens with the network off.
- `offline-update` a page opened before a deploy still starts listening after the browser has found the new version. Once it closes, the next page runs the new version from its cache.

## How to get to it (user POV)

- Open the app once while online, then open it again anywhere.
- Leave the app open while a new version is published, then press `Start listening`. Close every page of the app and open it again to get the new version.

## Driving it with verify.sh

Preconditions: none beyond the baseline.

- **Both pages.** Run `verify.sh drive e2e/offline.spec.ts 'opens with no network'`. Both headings render from the cache while the service worker itself cannot reach the network.
- **Across a deploy.** Run `verify.sh drive e2e/offline.spec.ts 'across a deploy'`. The old page decodes the fake microphone after the update, and the page opened after it closes listens on the new version with the network off.

## Gotchas

- Plain Playwright offline mode does not reach service workers. The spec sets the flag that makes the worker offline too, so a cache miss fails.
- Playwright cannot rewrite the service worker the browser fetches when it checks for an update. The deploy journey serves the old version instead: on the first visit, routes hand out this build with its decoder and cache renamed, and the deploy drops those routes.
- A reload does not bring in a new version, not even of the only open page: the old page is still open while the reload loads. Close every page of the app.
