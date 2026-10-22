import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { checkInRow, expect, feedItem, joinAir, nodeId, openTab, proof, sendText, setNickname, test } from './helpers';

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

test('a message to everyone says once another phone has passed it on, and the keyboard stays in the box', async ({ context }) => {
  const a = await context.newPage();
  await joinAir(a);
  const b = await context.newPage();
  await joinAir(b);

  await a.getByRole('link', { name: 'Skip to the message box' }).focus();
  await a.keyboard.press('Enter');
  const box = a.getByPlaceholder('Say something');
  await expect(box).toBeFocused();
  await a.keyboard.type('Water and blankets at the north stairwell');
  await a.keyboard.press('Tab');
  await a.keyboard.press('Tab');
  await expect(a.getByRole('button', { name: 'Send', exact: true })).toBeFocused();
  await a.keyboard.press('Enter');
  await expect(box).toBeEmpty();
  await expect(box).toBeFocused();
  await expect(a.locator('#compose [aria-live="polite"]')).toHaveText('Sent to everyone in earshot.');
  await expect(feedItem(a, 'Water and blankets')).toContainText('another phone has it');
  await proof(a, 'passed-on');
});

test('Reply on a message addresses the answer to whoever wrote it', async ({ context }) => {
  const a = await context.newPage();
  await joinAir(a);
  const b = await context.newPage();
  await joinAir(b, '/?air=sim', 'Ben');

  await sendText(b, 'Anyone on floor 3?');
  await feedItem(a, 'Anyone on floor 3?').getByRole('button', { name: 'Reply to Ben' }).click();
  await expect(a.getByPlaceholder('Say something to Ben')).toBeFocused();
  await expect(a.getByRole('combobox', { name: 'To' })).toHaveValue(String(parseInt(await nodeId(b), 16)));
  await a.keyboard.type('Yes, flat 3C');
  await a.keyboard.press('Enter');
  await expect(feedItem(b, 'Yes, flat 3C')).toContainText('direct to you');
  // Coming back to the feed later leaves the keyboard where it was: the box is not opened again.
  await openTab(a, 'Safety');
  await openTab(a, 'Feed');
  await expect(a.getByRole('tab', { name: 'Feed' })).toBeFocused();
});

test('a direct message shows only to its addressee and comes back delivered', async ({ context }) => {
  const [a, b, c] = await Promise.all([0, 1, 2].map(() => context.newPage()));
  for (const p of [a, b, c]) await joinAir(p);
  const text = 'Can you bring the first aid kit to room 412?';

  await openTab(a, 'People');
  await a.getByRole('button', { name: `Message #${await nodeId(b)} directly` }).click();
  await sendText(a, text);
  // Its frame takes a few seconds to play.
  await expect(feedItem(a, text)).toContainText('waiting to go on air…');
  await expect(feedItem(b, text)).toContainText('direct to you');
  await expect(feedItem(a, text)).toContainText('delivered');
  await expect(c.getByText(text)).toHaveCount(0);
  await proof(a, 'direct');
});

test('a contact card arrives and saves as a vCard', async ({ context }) => {
  const a = await context.newPage();
  await joinAir(a);
  const b = await context.newPage();
  await joinAir(b);

  await a.getByRole('radio', { name: 'Contact', exact: true }).click();
  await a.getByLabel('Name', { exact: true }).fill('Dr Okafor');
  await a.getByLabel('Phone', { exact: true }).fill('+44 20 7946 0000');
  await a.getByLabel('Contact note').fill('Medic, east gate');
  await a.getByRole('button', { name: 'Send', exact: true }).click();

  const card = feedItem(b, 'Dr Okafor');
  await expect(card.getByRole('link', { name: '+44 20 7946 0000' })).toHaveAttribute('href', 'tel:+442079460000');
  await expect(card).toContainText('Medic, east gate');
  const [download] = await Promise.all([b.waitForEvent('download'), card.getByRole('button', { name: 'Save contact' }).click()]);
  expect(download.suggestedFilename()).toBe('Dr Okafor.vcf');
  const vcard = await readFile(await download.path(), 'utf8');
  expect(vcard).toContain('FN:Dr Okafor\r\n');
  expect(vcard).toContain('TEL:+44 20 7946 0000\r\n');
  await proof(b, 'contact');
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
  // Only a picture is shown as itself. Anything else stays a download, so a web page someone sends never runs as this app.
  expect(await save.evaluate(async (link: HTMLAnchorElement) => (await (await fetch(link.href)).blob()).type)).toBe('application/octet-stream');
  await proof(b, 'file');
});
