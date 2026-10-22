import { expect, proof, test } from './helpers';

// By default Playwright's offline mode does not reach service workers: a cache miss would be
// fetched from the server and this test would pass for the wrong reason. With this flag the
// service worker is offline too, so everything has to come out of its cache.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

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
  await expect(page.getByRole('heading', { name: /^Messages that travel through the air/ })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'Start listening' })).toBeEnabled();
  await proof(page, 'offline');

  await page.goto('/beacon.html');
  await expect(page.getByRole('heading', { name: 'Leave this device here as a relay.' })).toBeVisible();
});
