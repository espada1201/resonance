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
  await expect(page.getByText(/^Nothing heard yet/)).toBeVisible();
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
  // Once it shows, moving along the tabs moves nothing.
  const before = await page.getByRole('tabpanel').boundingBox();
  await page.keyboard.press('ArrowLeft');
  expect(await page.getByRole('tabpanel').boundingBox()).toEqual(before);
  await page.locator('main').click({ position: { x: 5, y: 5 } });
  await expect(hint).toBeHidden();
});

for (const width of [360, 1280]) {
  test.describe(`keyboard hint at ${width} px`, () => {
    test.use({ viewport: { width, height: 800 } });

    test('never covers the top of the page while a tab has the keyboard', async ({ page }) => {
      await joinAir(page);
      for (const tab of ['Feed', 'Safety', 'Settings'] as const) {
        await page.getByRole('tab', { name: tab, exact: true }).focus();
        await page.keyboard.press(tab === 'Settings' ? 'ArrowLeft' : 'ArrowRight');
        const hint = page.getByText('Arrow keys switch tabs');
        await expect(hint).toBeVisible();
        const hintBox = (await hint.boundingBox())!;
        const panelBox = (await page.getByRole('tabpanel').boundingBox())!;
        // The panel's first line of content, wherever the tab put it.
        const first = (await page.getByRole('tabpanel').locator(':scope > *').first().boundingBox())!;
        expect(hintBox.y + hintBox.height, `${tab}: the hint ends above the panel`).toBeLessThanOrEqual(panelBox.y + 0.5);
        expect(hintBox.y + hintBox.height, `${tab}: the hint ends above the first content`).toBeLessThanOrEqual(first.y + 0.5);
        expect(hintBox.x, 'the hint is inside the page').toBeGreaterThanOrEqual(0);
        expect(hintBox.x + hintBox.width, 'the hint is inside the page').toBeLessThanOrEqual(width);
      }
    });
  });
}
