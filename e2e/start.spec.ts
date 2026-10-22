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
