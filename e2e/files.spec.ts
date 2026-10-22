import { expect, proof, test } from './helpers';

// A 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

test('picking another photo lets go of the last preview', async ({ page }) => {
  // A preview is an object URL, and one never revoked keeps its photo in memory until the page closes.
  await page.addInitScript(() => {
    const revoke = URL.revokeObjectURL;
    const revoked: string[] = [];
    Object.assign(window, { revoked });
    URL.revokeObjectURL = (url) => {
      revoked.push(url);
      revoke(url);
    };
  });
  await page.goto('/?air=sim');
  await page.getByRole('radio', { name: 'Tiny file', exact: true }).click();
  const choose = page.getByLabel('Choose a file or photo');
  const preview = (name: string) => page.getByText(`${name} · ${PNG.length} B`).locator('img');
  await choose.setInputFiles({ name: 'stairwell.png', mimeType: 'image/png', buffer: PNG });
  const first = await preview('stairwell.png').getAttribute('src');
  await choose.setInputFiles({ name: 'exit.png', mimeType: 'image/png', buffer: PNG });
  await expect(preview('exit.png')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { revoked: string[] }).revoked)).toEqual([first]);
  await proof(page, 'photo-preview');
});
