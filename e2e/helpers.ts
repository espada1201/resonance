import { type Locator, type Page, test as base, expect } from '@playwright/test';

/** Every page a test opens is watched: any console error or uncaught exception fails the test. */
export const test = base.extend<{ watchErrors: void }>({
  watchErrors: [
    async ({ context }, use) => {
      const errors: string[] = [];
      const watch = (page: Page) => {
        page.on('console', (m) => {
          if (m.type() === 'error') errors.push(`${page.url()} console.error: ${m.text()}`);
        });
        page.on('pageerror', (e) => errors.push(`${page.url()} uncaught: ${e.message}`));
      };
      context.pages().forEach(watch);
      context.on('page', watch);
      await use();
      expect(errors, 'console errors and uncaught exceptions').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** Rows of the air log ("IN"/"OUT"), filtered by what they describe. */
export const airRow = (page: Page, dir: 'IN' | 'OUT', what: string | RegExp) =>
  page
    .getByRole('list', { name: 'Air activity' })
    .getByRole('listitem')
    .filter({ has: page.getByText(dir, { exact: true }) })
    .filter({ hasText: what })
    .first();

export const feedItem = (page: Page, text: string | RegExp) => page.getByRole('article').filter({ hasText: text });

/** The air state line in the page header ("Listening", "Transmitting · 2.1 s", …). */
export const airStatus = (page: Page) => page.getByRole('banner').getByRole('status');

/** This station's six-digit mesh id, as shown in its header. */
export async function nodeId(page: Page): Promise<string> {
  const chip = await page.getByRole('banner').getByText(/#[0-9A-F]{6}/).first().textContent();
  return /#([0-9A-F]{6})/.exec(chip ?? '')![1];
}

/** The number under a label in a stats grid. */
export async function stat(scope: Page | Locator, label: string): Promise<number> {
  const cell = scope.locator('dl > div').filter({ has: scope.getByText(label, { exact: true }) });
  return Number(await cell.first().locator('dd').textContent());
}

/**
 * Opens a station on the simulated air and waits until its startup HELLO has been on air and
 * the room is quiet again, so the test's own transmissions do not collide with it.
 */
export async function joinAir(page: Page, path = '/?air=sim') {
  await page.goto(path);
  // Narrow layouts keep the air log behind its own tab.
  const airTab = page.getByRole('tab', { name: 'Air', exact: true });
  const narrow = await airTab.isVisible();
  if (narrow) await airTab.click();
  await expect(airRow(page, 'OUT', 'hello')).toBeVisible({ timeout: 20_000 });
  await expect(airStatus(page)).toHaveText('Listening', { timeout: 20_000 });
  if (narrow) await page.getByRole('tab', { name: 'Feed', exact: true }).click();
}

export async function openTab(page: Page, name: 'Feed' | 'Safety' | 'People' | 'Settings' | 'Air') {
  await page.getByRole('tab', { name, exact: true }).click();
}

export async function sendText(page: Page, text: string) {
  await openTab(page, 'Feed');
  await page.getByRole('tab', { name: 'Message', exact: true }).click();
  const box = page.getByPlaceholder('Say something');
  await box.fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(box).toBeEmpty();
}

export async function setNickname(page: Page, nick: string) {
  await openTab(page, 'Settings');
  await page.getByLabel('Nickname').fill(nick);
  await openTab(page, 'Feed');
}
