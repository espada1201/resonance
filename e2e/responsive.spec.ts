import { fileURLToPath } from 'node:url';
import { checkInRow, expect, feedItem, joinAir, openTab, sendText, test } from './helpers';

const SCREENS = fileURLToPath(new URL('.out/screens/', import.meta.url));

const LAYOUTS = [
  { name: 'desktop', width: 1440, height: 900, tabs: ['Feed', 'Safety', 'People', 'Settings'] },
  // Below 960 px the air panel moves from the side into its own tab.
  { name: 'phone', width: 390, height: 844, tabs: ['Feed', 'Safety', 'Air', 'People', 'Settings'] },
] as const;

for (const layout of LAYOUTS) {
  test.describe(`${layout.name} ${layout.width}x${layout.height}`, () => {
    test.use({
      viewport: { width: layout.width, height: layout.height },
      permissions: ['geolocation'],
      geolocation: { latitude: 51.5007, longitude: -0.1246, accuracy: 8 },
    });

    test('every tab renders with content and no sideways scrolling', async ({ context }) => {
      const a = await context.newPage();
      await joinAir(a, '/?air=sim', 'Ana');
      const b = await context.newPage();
      await joinAir(b, '/?air=sim', 'Ben');

      // Each station sends once: a second send right behind the first would race the other
      // station's relay of it, and this test is about layout, not collisions.
      const text = 'Water and blankets at the north stairwell, level 2. Bring a torch: the lights are out.';
      await sendText(b, text);
      await expect(feedItem(a, text)).toContainText('heard directly');
      await openTab(a, 'Safety');
      await a.getByRole('button', { name: "I'm safe" }).click();
      await openTab(b, 'Safety');
      await b.getByRole('button', { name: 'Use my position' }).click();
      await expect(checkInRow(b, 'Ana')).toContainText('Safe');

      await expect(b.getByRole('tablist', { name: 'Sections' }).getByRole('tab')).toHaveText([...layout.tabs]);
      for (const tab of layout.tabs) {
        await openTab(b, tab);
        await b.screenshot({ path: `${SCREENS}${layout.name}-${tab.toLowerCase()}.png`, animations: 'disabled' });
        const width = await b.evaluate(() => document.documentElement.scrollWidth);
        expect(width, `${tab} tab must not scroll sideways`).toBeLessThanOrEqual(layout.width);
      }
    });
  });
}
