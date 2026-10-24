import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { type Page, test as base, expect } from '@playwright/test';
import { BROADCAST, type PacketType, encodePacket, randomNodeId, randomU32 } from '../src/mesh/packet';
import { modulate } from '../src/modem/modulator';
import { PROFILES } from '../src/modem/profiles';

/** Any console error or uncaught exception in any page or worker of the test fails it. */
export const test = base.extend<{ watchErrors: void }>({
  watchErrors: [
    async ({ context }, use) => {
      const errors: string[] = [];
      context.on('console', (m) => {
        if (m.type() === 'error') errors.push(`console.error on ${m.page()?.url()}: ${m.text()}`);
      });
      context.on('weberror', (e) => errors.push(`uncaught on ${e.page()?.url()}: ${e.error().message}`));
      await use();
      expect(errors, 'console errors and uncaught exceptions').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** Evidence for a verification run: a screenshot and the accessibility tree, in e2e/.out/verify/<spec>/<name>.*. */
export async function proof(page: Page, name: string) {
  const info = test.info();
  const dir = join(info.project.testDir, '.out', 'verify', basename(info.file, '.spec.ts'));
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`) });
  await writeFile(join(dir, `${name}.aria.txt`), await page.locator('body').ariaSnapshot());
}

/** The newest air log row ("IN"/"OUT") whose text contains every one of `what`. */
export function airRow(page: Page, dir: 'IN' | 'OUT', ...what: Array<string | RegExp>) {
  let rows = page
    .getByRole('list', { name: 'Sound activity' })
    .getByRole('listitem')
    .filter({ has: page.getByText(dir, { exact: true }) });
  for (const w of what) rows = rows.filter({ hasText: w });
  return rows.first();
}

export const feedItem = (page: Page, text: string | RegExp) => page.getByRole('article').filter({ hasText: text });

/** A person's row in the Safety tab's list of check-ins. */
export const checkInRow = (page: Page, who: string) =>
  page.getByRole('listitem').filter({ has: page.getByText(who, { exact: true }) });

/** This station's six-digit mesh id, as shown in its header. */
export async function nodeId(page: Page): Promise<string> {
  const chip = await page.getByRole('banner').getByText(/#[0-9A-F]{6}/).first().textContent();
  return /#([0-9A-F]{6})/.exec(chip ?? '')![1];
}

/** The number under a label in a stats grid. */
export async function stat(page: Page, label: string): Promise<number> {
  const cell = page.locator('dl > div').filter({ has: page.getByText(label, { exact: true }) });
  return Number(await cell.first().locator('dd').textContent());
}

/**
 * Opens a station on the simulated air and waits until its startup HELLO has been on air and
 * the room is quiet again, so the test's own transmissions do not collide with it.
 */
export async function joinAir(page: Page, path = '/?air=sim', nick?: string) {
  await page.goto(path);
  // Usually beats the HELLO (1.5-4.5 s after start), so neighbours learn the name; tests that
  // must tell stations apart use node ids instead.
  if (nick) await setNickname(page, nick);
  // Narrow layouts keep the air log behind its own tab.
  const airTab = page.getByRole('tab', { name: 'Sound', exact: true });
  const narrow = await airTab.isVisible();
  if (narrow) await airTab.click();
  await expect(airRow(page, 'OUT', 'hello')).toBeVisible({ timeout: 20_000 });
  // The air state line ("Transmitting · 1.5 s", or "Sending 1.5 s" when compact).
  await expect(page.getByRole('status').first()).not.toHaveText(/Transmitting|Sending/, { timeout: 20_000 });
  if (narrow) await openTab(page, 'Feed');
}

export async function openTab(page: Page, name: 'Feed' | 'Safety' | 'People' | 'Settings' | 'Sound') {
  // Safety's name grows a count of people waiting for you ("Safety, 1 waiting for you").
  await page.getByRole('tab', { name: new RegExp(`^${name}($|,)`) }).click();
}

export async function sendText(page: Page, text: string) {
  await openTab(page, 'Feed');
  await page.getByRole('radio', { name: 'Message', exact: true }).click();
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

/**
 * Plays a packet into the page's simulated room, as anyone in earshot could: its body is bytes, so
 * it can say what no Resonance phone sends. The room's channel in that page hears it, as a
 * BroadcastChannel hears every other one of its name.
 */
export async function playPacket(page: Page, type: PacketType, body: Uint8Array, src = randomNodeId()) {
  const packet = encodePacket({ type, encrypted: false, ackRequested: false, msgId: randomU32(), src, dst: BROADCAST, ttl: 5, hops: 0, attempt: 0, channel: 0, body });
  const wave = [...modulate(packet, PROFILES.fast, 48000)];
  await page.evaluate((wave) => {
    new BroadcastChannel('resonance-air').postMessage({ wave: Float32Array.from(wave), gain: 1, at: performance.timeOrigin + performance.now(), x: 0, y: 0 });
  }, wave);
}
