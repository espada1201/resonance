import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { PacketType } from '../src/mesh/packet';
import { nowSec } from '../src/mesh/payloads';
import { checkInRow, expect, feedItem, joinAir, openTab, playPacket, sendText, test } from './helpers';

const SCREENS = fileURLToPath(new URL('.out/screens/', import.meta.url));

const LAYOUTS = [
  { name: 'desktop', width: 1440, height: 900, tabs: ['Feed', 'Safety', 'People', 'Settings'] },
  // Below 960 px the air panel moves from the side into its own tab.
  { name: 'phone', width: 390, height: 844, tabs: ['Feed', 'Safety', 'Air', 'People', 'Settings'] },
  { name: 'small phone', width: 360, height: 740, tabs: ['Feed', 'Safety', 'Air', 'People', 'Settings'] },
] as const;

/**
 * Visible boxes in the main area whose content is wider than they are, apart from text cut off on purpose
 * with an ellipsis. The page can stay one screen wide while a card's content spills out of it or
 * a panel scrolls sideways.
 */
function spills(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('main *')]
      .filter((el) => el instanceof HTMLElement && el.clientWidth > 1 && el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).textOverflow !== 'ellipsis')
      .map((el) => `${el.scrollWidth} > ${el.clientWidth}: ${el.outerHTML.slice(0, 100)}`),
  );
}

/** A message body as a phone writes one (time, nickname with its length, text), but with any nickname: phones cut theirs to 16 bytes. */
function messageFrom(nick: string, text: string) {
  const enc = new TextEncoder();
  const ts = new DataView(new ArrayBuffer(4));
  ts.setUint32(0, nowSec());
  return Uint8Array.from([...new Uint8Array(ts.buffer), enc.encode(nick).length, ...enc.encode(nick), ...enc.encode(text)]);
}

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
      // A long unbroken token (a link, an email) must wrap inside its card, not push it off screen.
      const text = 'Water and blankets at the north stairwell, level 2. Map: https://example.org/shelters/lambeth-north-stairwell-level-2';
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
        expect(await spills(b), `${tab} tab: nothing sticks out past the screen edge`).toEqual([]);
      }
    });

    test('a nickname longer than any phone sends stays inside its card', async ({ page }) => {
      await joinAir(page);
      const text = 'Played into the room by a stranger';
      await playPacket(page, PacketType.Text, messageFrom('W'.repeat(100), text));
      await expect(feedItem(page, text)).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth), 'the feed must not scroll sideways').toBeLessThanOrEqual(layout.width);
      expect(await spills(page), 'nothing sticks out past the screen edge').toEqual([]);
    });
  });
}
