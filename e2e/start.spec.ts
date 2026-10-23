import { expect, joinAir, proof, test } from './helpers';

// Getting on the air: with the microphone, or on simulated air in two tabs of one browser.

test('"Try a demo" opens a second tab on simulated air', async ({ context, page }) => {
  await page.goto('/');
  const [second] = await Promise.all([context.waitForEvent('page'), page.getByRole('link', { name: 'Try a demo, no microphone needed' }).click()]);
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

test('the keyboard is told the arrow keys switch tabs, and a touch or mouse user is not', async ({ page }) => {
  await joinAir(page);
  const hint = page.getByText('Arrow keys switch tabs');
  await expect(hint).toBeHidden();
  // Mouse use leaves the tab focused but is no keyboard use: no hint.
  await page.getByRole('tab', { name: 'Safety', exact: true }).click();
  await expect(hint).toBeHidden();
  await page.getByRole('tab', { name: 'Safety', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'People' })).toBeFocused();
  await expect(hint).toBeVisible();
  // It floats over the page: showing it moves nothing.
  const before = await page.getByRole('tabpanel').boundingBox();
  await page.keyboard.press('ArrowLeft');
  expect(await page.getByRole('tabpanel').boundingBox()).toEqual(before);
  await page.locator('main').click({ position: { x: 5, y: 5 } });
  await expect(hint).toBeHidden();
});
