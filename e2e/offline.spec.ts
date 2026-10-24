import { FAKE_MIC_WAV, fakeMicText } from './fake-mic';
import { expect, feedItem, proof, test } from './helpers';

// By default Playwright's offline mode does not reach service workers: a cache miss would be
// fetched from the server and this test would pass for the wrong reason. With this flag the
// service worker is offline too, so everything has to come out of its cache, and context.route
// sees what the service worker fetches.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

// The decoder is fetched only when Start is pressed, which needs a microphone: Chromium's fake
// capture device plays the recording from global-setup.ts.
test.use({
  permissions: ['microphone'],
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${FAKE_MIC_WAV}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
});

test('opens with no network once the service worker has cached it', async ({ page, context }) => {
  const registered = context.waitForEvent('serviceworker');
  await page.goto('/');
  const worker = await registered;
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.reload();
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

  await context.setOffline(true);
  expect(await worker.evaluate(() => fetch('./', { cache: 'no-store' }).then(() => 'online', () => 'offline'))).toBe('offline');

  await page.reload();
  // Either the cache has the whole app or it does not: no need to wait long.
  await expect(page.getByRole('heading', { name: /^Messages that travel by sound/ })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'Start listening' })).toBeEnabled();
  await proof(page, 'offline');

  await page.goto('/beacon.html');
  await expect(page.getByRole('heading', { name: 'Leave this device here as a relay.' })).toBeVisible();
});

test('a page left open across a deploy still starts listening, and the new version takes over once it closes', async ({ page, context }) => {
  // Each build names its decoder, and its cache, after its files. The version before the deploy is
  // this build under other names: the first visit gets it, the page and its service worker alike.
  const before = (js: string) =>
    js.replace(/rx-worker-([\w-]+?)\.js/g, 'rx-worker-$1-old.js').replace("const CACHE = 'resonance-", "const CACHE = 'resonance-old-");
  await context.route('**/*.js', async (route) => {
    const response = await route.fetch({ url: route.request().url().replace('-old.js', '.js') });
    await route.fulfill({ response, body: before(await response.text()) });
  });
  await page.goto('/');
  // The first visit comes under the service worker without a reload, so it could already lose the network.
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  const [oldCache] = await page.evaluate(() => caches.keys());

  // The deploy: the server holds this build as it is, and answers 404 for the old decoder, as Pages
  // does (the preview server would answer with index.html).
  await context.unrouteAll({ behavior: 'wait' });
  await context.route('**/rx-worker-*-old.js', (route) => route.fulfill({ status: 404 }));
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    await registration.update();
    const update = registration.installing!;
    await new Promise<void>((installed) => {
      const check = () => update.state !== 'installing' && installed();
      update.onstatechange = check;
      check();
    });
  });

  const decoder = page.waitForResponse(/rx-worker-/);
  await page.getByRole('button', { name: 'Start listening' }).click();
  expect((await decoder).status()).toBe(200);
  await expect(page.getByRole('status')).toHaveText('Listening');
  await expect(feedItem(page, fakeMicText('audible'))).toBeVisible();
  await proof(page, 'across-a-deploy');

  // Once no page needs the old version, the new one takes over, and runs from its own cache.
  await page.close();
  await context.setOffline(true);
  const next = await context.newPage();
  await next.goto('/');
  expect(await next.evaluate(() => caches.keys())).not.toContain(oldCache);
  const newDecoder = next.waitForResponse(/rx-worker-/);
  await next.getByRole('button', { name: 'Start listening' }).click();
  expect((await newDecoder).status()).toBe(200);
  await expect(next.getByRole('status')).toHaveText('Listening');
});
