import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { checkInRow, expect, feedItem, joinAir, openTab, proof, sendText, setNickname, test } from './helpers';

// Several tabs of one browser context share a simulated room (BroadcastChannel + noise), so
// every frame below is really modulated, mixed and demodulated, just not played aloud.

test('two stations trade messages over the air', async ({ context }) => {
  const a = await context.newPage();
  await joinAir(a);
  const b = await context.newPage();
  await joinAir(b);

  await sendText(a, 'Water and blankets at the north stairwell');
  await expect(feedItem(b, 'Water and blankets at the north stairwell')).toContainText('heard directly');

  await sendText(b, 'On my way, bringing a torch');
  await expect(feedItem(a, 'On my way, bringing a torch')).toContainText('heard directly');
  await proof(a, 'messages');
});

test.describe('check-ins', () => {
  // Ana checks in from Westminster Bridge; Ben is 300 m due south of her.
  const ANA = { latitude: 51.5007, longitude: -0.1246, accuracy: 8 };
  const BEN = { latitude: 51.498, longitude: -0.1246, accuracy: 8 };
  test.use({ permissions: ['geolocation'], geolocation: ANA });

  test("I'm safe reaches the other station with a GPS fix", async ({ context }) => {
    const a = await context.newPage();
    await joinAir(a);
    const b = await context.newPage();
    await joinAir(b);
    await setNickname(a, 'Ana');

    await openTab(a, 'Safety');
    await a.getByRole('button', { name: "I'm safe" }).click();
    await expect(checkInRow(a, 'You')).toContainText('Safe');

    await context.setGeolocation(BEN);
    await openTab(b, 'Safety');
    await b.getByRole('button', { name: 'Use my position' }).click();
    const row = checkInRow(b, 'Ana');
    await expect(row).toContainText('Safe');
    await expect(row).toContainText('300 m N');
    await expect(b.getByRole('img', { name: 'Map of 1 check-ins around you' })).toBeVisible();

    await openTab(b, 'Feed');
    const item = feedItem(b, 'Ana');
    await expect(item).toContainText('Safe');
    await expect(item).toContainText('300 m N of you · ±8 m');
    await proof(b, 'check-in');
  });
});

async function joinCircle(page: Page, passphrase: string) {
  await openTab(page, 'Settings');
  await page.getByLabel('Circle passphrase').fill(passphrase);
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText('are sealed with AES-256-GCM')).toBeVisible();
  await openTab(page, 'Feed');
}

test('a circle passphrase seals messages from everyone outside it', async ({ context }) => {
  const [a, b, c, d] = await Promise.all([0, 1, 2, 3].map(() => context.newPage()));
  for (const p of [a, b, c, d]) await joinAir(p);
  await joinCircle(a, 'blue lantern 7');
  await joinCircle(b, 'blue lantern 7');
  await joinCircle(d, 'a different circle');

  const secret = 'Meet behind the library at six';
  await sendText(a, secret);
  await expect(feedItem(b, secret)).toContainText('circle');
  // c has no passphrase, d has the wrong one: both relay it but cannot read it.
  for (const outsider of [c, d]) {
    await expect(feedItem(outsider, 'Sealed for a circle you are not in')).toBeVisible();
    await expect(outsider.getByText(secret)).toHaveCount(0);
  }
  await proof(c, 'sealed');
});

test('a tiny file crosses the air in chunks and reassembles byte for byte', async ({ context }) => {
  test.setTimeout(240_000);
  const a = await context.newPage();
  await joinAir(a);
  const b = await context.newPage();
  await joinAir(b);

  // ~300 bytes: a name/type chunk plus two data chunks.
  const content = Buffer.from(
    'Open shelters tonight\n' +
      '1. St Thomas church hall, Lambeth Palace Rd: 40 beds, hot food until 22:00\n' +
      '2. County Hall basement, Belvedere Rd: 25 beds, first aid on site\n' +
      '3. Archbishop Park pavilion: dry floor space, bring a blanket\n' +
      'Water point: Westminster Bridge Rd fountain (working)\n',
  );
  await a.getByRole('radio', { name: 'Tiny file', exact: true }).click();
  await a.getByLabel('Choose a file or photo').setInputFiles({ name: 'shelters.txt', mimeType: 'text/plain', buffer: content });
  await expect(a.getByText(`shelters.txt · ${content.length} B`)).toBeVisible();
  await a.getByRole('button', { name: 'Send', exact: true }).click();

  const save = feedItem(b, 'shelters.txt').getByRole('link', { name: 'Save file' });
  await expect(save).toBeVisible({ timeout: 200_000 });
  const [download] = await Promise.all([b.waitForEvent('download'), save.click()]);
  expect(download.suggestedFilename()).toBe('shelters.txt');
  expect((await readFile(await download.path())).equals(content)).toBe(true);
  await proof(b, 'file');
});
