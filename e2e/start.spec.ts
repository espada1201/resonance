import { expect, proof, test } from './helpers';

// Getting on the air: with the microphone, or on simulated air in two tabs of one browser.

test('"Try it in two tabs" opens a second tab on simulated air', async ({ context, page }) => {
  await page.goto('/');
  const [second] = await Promise.all([context.waitForEvent('page'), page.getByRole('link', { name: 'Try it in two tabs, no microphone' }).click()]);
  await expect(page).toHaveURL(/air=sim/);
  await expect(second).toHaveURL(/air=sim/);
  for (const p of [page, second]) await expect(p.getByText('Simulated air').or(p.getByText('Sim', { exact: true })).first()).toBeVisible();
  await proof(second, 'two-tabs');
});

test('on simulated air the page is listening before its first hello', async ({ page }) => {
  // Paused fake time holds every timer, and a station's first hello waits at least 1.5 s after it starts.
  await page.clock.install();
  await page.clock.pauseAt(Date.now() + 1_000);
  await page.goto('/?air=sim');
  await page.clock.runFor(1_000);
  await expect(page.getByRole('status')).toHaveText('Listening');
  await expect(page.getByPlaceholder('Say something')).toBeVisible();
  await expect(page.getByText(/^Nothing on the air yet/)).toBeVisible();
  await proof(page, 'sim-ready');
});
