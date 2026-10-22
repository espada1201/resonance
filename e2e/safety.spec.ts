import { readFile } from 'node:fs/promises';
import { airRow, checkInRow, expect, feedItem, joinAir, openTab, proof, sendText, test } from './helpers';

// The jobs people have when the network is down: say how you are and what you need, see who
// needs help and answer them, get word to family outside, and tell everyone nearby what matters.

test('a call for help travels with its details, gets an answer, and closes when they are safe', async ({ context }) => {
  test.setTimeout(240_000);
  const a = await context.newPage();
  await joinAir(a);
  const b = await context.newPage();
  await b.addInitScript(() => {
    const w = window as unknown as { buzzes: unknown[] };
    w.buzzes = [];
    navigator.vibrate = (p) => w.buzzes.push(p) > 0;
  });
  await joinAir(b, '/?air=sim', 'Ben');

  await openTab(a, 'Safety');
  await a.getByLabel('Your name').fill('Ana');
  await a.getByText('More detail').click();
  await expect(a.getByRole('radiogroup', { name: 'Status' }).getByRole('radio')).toHaveText(['Safe', 'Needs help', 'Needs medical help', 'Sheltering']);
  await a.getByRole('radio', { name: 'Needs help' }).click();
  await a.getByRole('button', { name: 'Trapped' }).click();
  await a.getByRole('button', { name: 'Water' }).click();
  await a.getByLabel('Where', { exact: true }).fill('Floor 4, room 412');
  await a.getByRole('button', { name: 'Send check-in' }).click();

  // Ben is reading the feed: his phone buzzes once, the title counts the request, a screen reader says it.
  await expect(b).toHaveTitle('(1) Resonance');
  await expect(b.locator('[aria-live="assertive"]')).toHaveText('Needs help: Ana');
  expect(await b.evaluate(() => (window as unknown as { buzzes: unknown[] }).buzzes)).toHaveLength(1);
  await openTab(b, 'Safety');
  const ana = checkInRow(b, 'Ana');
  await expect(ana).toContainText('Waiting for help');
  await expect(ana).toContainText('Trapped');
  await expect(ana).toContainText('Floor 4, room 412');
  await expect(b.getByRole('tab', { name: 'Safety, 1 open request' })).toBeVisible();
  await ana.getByRole('button', { name: 'On my way' }).click();
  await expect(ana).toContainText('You are on the way');

  await expect(checkInRow(a, 'You')).toContainText('Ben is on the way');
  await expect(checkInRow(a, 'You')).not.toContainText('heard directly');
  // Resolved closes the request on every phone, so it asks once more.
  await ana.getByRole('button', { name: 'Resolved', exact: true }).click();
  await expect(ana.getByRole('group', { name: 'Resolved for everyone?' })).toBeVisible();
  await expect(ana.getByRole('button', { name: 'Not yet' })).toBeFocused();
  await ana.getByRole('button', { name: 'Not yet' }).click();
  await expect(ana).toContainText('Help on the way');
  await ana.getByRole('button', { name: 'Resolved', exact: true }).click();
  await ana.getByRole('button', { name: 'Yes, resolved' }).click();
  await expect(checkInRow(a, 'You')).toContainText('Resolved');
  await expect(a.getByRole('tab', { name: 'Safety', exact: true })).toBeVisible();
  await a.getByRole('button', { name: "I'm safe" }).click();
  await expect(ana).toContainText('Safe');
  await expect(ana).not.toContainText('Waiting for help');
  await expect(b.getByRole('tab', { name: 'Safety', exact: true })).toBeVisible();
  await expect(b).toHaveTitle('Resonance');
  await proof(b, 'call-for-help');
});

test('one tap for help goes on air within seconds while the location prompt waits for an answer', async ({ page }) => {
  // A prompt nobody answers never calls back, and the browser's own timeout starts only after an answer.
  await page.addInitScript(() => {
    navigator.geolocation.getCurrentPosition = () => undefined;
  });
  await joinAir(page, '/?air=sim', 'Ana');
  await openTab(page, 'Safety');
  await page.getByRole('button', { name: 'I need help' }).click();
  await expect(checkInRow(page, 'You')).toContainText('Waiting for help', { timeout: 8_000 });
  await expect(airRow(page, 'OUT', 'check-in')).toBeVisible({ timeout: 8_000 });
  // Its rows hold nothing to tab to, so the log itself takes focus for the keyboard to scroll it.
  await expect(page.getByRole('region', { name: 'Air log' })).toHaveAttribute('tabindex', '0');
  await proof(page, 'help-without-fix');
});

test('a check-in from the compose bar goes out without a position when GPS fails', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.geolocation.getCurrentPosition = (_found, failed) => setTimeout(() => failed?.({ code: 2 } as GeolocationPositionError));
  });
  await joinAir(page, '/?air=sim', 'Ana');
  await page.getByRole('radio', { name: 'Check in', exact: true }).click();
  await page.getByLabel('Attach my GPS position').check();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(airRow(page, 'OUT', 'check-in')).toBeVisible({ timeout: 8_000 });
  await expect(page.getByRole('alert')).toHaveText('Could not get a location fix. Sent without a position.');
  await openTab(page, 'Safety');
  await expect(checkInRow(page, 'You')).toContainText('Safe');
  await proof(page, 'compose-without-fix');
});

test('the big help button sends the details open beside it, then says whether anyone answered', async ({ context }) => {
  const a = await context.newPage();
  await joinAir(a, '/?air=sim', 'Ana');
  const b = await context.newPage();
  await joinAir(b, '/?air=sim', 'Ben');

  await openTab(a, 'Safety');
  await a.getByText('More detail').click();
  await a.getByRole('radio', { name: 'Needs help' }).click();
  await a.getByRole('button', { name: 'Trapped' }).click();
  await a.getByLabel('Note').fill('Leg stuck under a beam');
  await a.getByRole('button', { name: 'I need help' }).click();
  const mine = checkInRow(a, 'You');
  await expect(mine).toContainText('Trapped');
  await expect(mine).toContainText('Leg stuck under a beam');
  await expect(a.getByLabel('Note')).toBeEmpty();
  await expect(a.getByText('Waiting to go on air…')).toBeVisible();
  await expect(a.getByText('Sent. Nobody has answered yet.')).toBeVisible();

  await openTab(b, 'Safety');
  const ana = checkInRow(b, 'Ana');
  await expect(ana).toContainText('Trapped');
  await expect(ana).toContainText('Leg stuck under a beam');
  await ana.getByRole('button', { name: 'On my way' }).click();
  await expect(a.getByText('Sent. Ben is on the way.')).toBeVisible();
  await proof(a, 'big-button-details');
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('who needs help is on the first screen even with cards for family outside, and Find reads out in their entry', async ({ context }) => {
    const a = await context.newPage();
    await joinAir(a, '/?air=sim', 'Ana');
    const b = await context.newPage();
    await joinAir(b, '/?air=sim', 'Ben');

    await openTab(b, 'Safety');
    await b.getByText('More detail').click();
    await b.getByRole('radio', { name: 'Needs help' }).click();
    await b.getByLabel('Family outside: phone or email').fill('+1 (555) 010-0199');
    await b.getByRole('button', { name: 'Send check-in' }).click();
    await openTab(a, 'Safety');
    const ben = a.getByRole('region', { name: /^Check-ins/ }).getByRole('listitem').first();
    await expect(ben).toContainText('Ben');

    await openTab(a, 'Feed');
    await a.getByRole('radio', { name: 'Check in', exact: true }).click();
    await a.getByLabel('Family outside: phone or email').fill('+1 (555) 010-0100');
    await a.getByRole('button', { name: 'Send', exact: true }).click();
    await openTab(a, 'Safety');
    await expect(a.getByRole('region', { name: 'Pass on to family outside' }).getByRole('listitem')).toHaveCount(2);
    await expect(ben).toBeInViewport({ ratio: 1 });

    await ben.getByRole('button', { name: /^Find / }).click();
    await expect(ben.getByRole('region', { name: 'Distance to Ben' })).toBeVisible();
    await proof(a, 'phone-roster-first');
  });
});

test('a phone with signal passes a check-in on to family outside, once', async ({ context }) => {
  test.setTimeout(180_000);
  const a = await context.newPage();
  await joinAir(a, '/?air=sim', 'Ana');
  const b = await context.newPage();
  await joinAir(b, '/?air=sim', 'Ben');

  await openTab(a, 'Safety');
  await a.getByText('More detail').click();
  await a.getByLabel('Family outside: phone or email').fill('+1 (555) 010-0100');
  await a.getByRole('button', { name: 'Send check-in' }).click();

  await openTab(b, 'Safety');
  const parcel = b.getByRole('region', { name: 'Pass on to family outside' }).getByRole('listitem').filter({ hasText: 'Ana' });
  await expect(parcel.getByRole('link', { name: 'Send as text' })).toHaveAttribute('href', /^sms:\+15550100100\?&body=Ana%20is%20safe\./);
  await parcel.getByRole('button', { name: 'I sent it' }).click();
  await expect(parcel).toContainText('You passed it on');

  // Ana's next one-tap check-in carries the same family contact without retyping it.
  await expect(a.getByRole('region', { name: 'Pass on to family outside' })).toContainText('Ben passed it on');
  await expect(a.getByText('Whoever gets signal first can tell +1 (555) 010-0100.', { exact: false })).toBeVisible();
  await proof(a, 'courier');
});

test('a notice is pinned on every feed', async ({ context }) => {
  const a = await context.newPage();
  await joinAir(a, '/?air=sim', 'Desk');
  const b = await context.newPage();
  await joinAir(b);

  await a.getByRole('radio', { name: 'Notice', exact: true }).click();
  await a.getByRole('radio', { name: 'Water', exact: true }).click();
  await a.getByLabel('Notice').fill('Drinking water at the school gym');
  await a.getByLabel('Where', { exact: true }).fill('Elm St school');
  await a.getByRole('button', { name: 'Send', exact: true }).click();

  const board = b.getByRole('region', { name: 'Notices' });
  await expect(board).toContainText('Drinking water at the school gym');
  await expect(board).toContainText('Elm St school');
  await expect(board).toContainText('from Desk');
  await proof(b, 'notice');
});

test('the safety list downloads as a spreadsheet, people without a phone included', async ({ context }) => {
  const a = await context.newPage();
  await joinAir(a, '/?air=sim', 'Ana');
  const b = await context.newPage();
  await joinAir(b);

  await openTab(a, 'Safety');
  await a.getByText('More detail').click();
  await a.getByLabel('For someone without a phone').check();
  await a.getByLabel('Their name').fill('María López');
  await a.getByRole('button', { name: 'Send check-in' }).click();

  await openTab(b, 'Safety');
  await expect(checkInRow(b, 'María López')).toContainText('reported by Ana');
  await b.getByRole('searchbox', { name: 'Search check-ins' }).fill('maria');
  await expect(checkInRow(b, 'María López')).toBeVisible();
  const [download] = await Promise.all([b.waitForEvent('download'), b.getByRole('button', { name: 'Spreadsheet' }).click()]);
  const csv = await readFile((await download.path())!, 'utf8');
  // The byte-order mark tells Excel the file is UTF-8; without it, María reads as MarÃ­a.
  expect(csv.split('\r\n')[0]).toBe('\uFEFFName,Reported by,Status,Request,Needs,Place,Note,Latitude,Longitude,Accuracy (m),Sent (UTC),Hops,Replies,Outside contact');
  expect(csv).toContain('María López,Ana,Safe,');
  await proof(b, 'spreadsheet');
});

test('People rates each neighbour signal in plain words', async ({ context }) => {
  const a = await context.newPage();
  await joinAir(a, '/?air=sim', 'Ana');
  const b = await context.newPage();
  await joinAir(b);
  // Ana said hello before Ben arrived; her next frame is the first he hears from her.
  await sendText(a, 'Water at the north stairwell');
  await openTab(b, 'People');
  await expect(b.getByRole('listitem').filter({ hasText: 'Ana' })).toContainText(/(Strong|Fair|Weak) signal · Audible/);
  // The air panel, beside the tabs at this width, opens with the same news in one line.
  await expect(b.getByText(/Hearing Ana \((strong|fair|weak), Audible\)/)).toBeVisible();
  await proof(b, 'signal');
});

test('a sealed message and file heard before joining the circle open once you join', async ({ context }) => {
  test.setTimeout(180_000);
  const a = await context.newPage();
  await joinAir(a);
  const b = await context.newPage();
  await joinAir(b);
  for (const [p, phrase] of [[a, 'blue lantern 7'], [b, 'wrong guess']] as const) {
    await openTab(p, 'Settings');
    await p.getByLabel('Circle passphrase').fill(phrase);
    await p.getByRole('button', { name: 'Apply' }).click();
    await expect(p.getByText('are sealed with AES-256-GCM')).toBeVisible();
  }
  await openTab(a, 'Feed');
  await a.getByPlaceholder('Say something').fill('Meet at the library');
  await a.getByRole('button', { name: 'Send', exact: true }).click();
  await a.getByRole('radio', { name: 'Tiny file', exact: true }).click();
  const route = Buffer.from('Take the canal path: the bridge is out.');
  await a.getByLabel('Choose a file or photo').setInputFiles({ name: 'route.txt', mimeType: 'text/plain', buffer: route });
  await expect(a.getByText(`route.txt · ${route.length} B`)).toBeVisible();
  await a.getByRole('button', { name: 'Send', exact: true }).click();
  await openTab(b, 'Feed');
  await expect(feedItem(b, 'Sealed for a circle you are not in')).toBeVisible();
  const chunks = b.getByRole('list', { name: 'Air activity' }).getByRole('listitem').filter({ hasText: 'file chunk from' });
  await expect(chunks).toHaveCount(2, { timeout: 120_000 });
  await expect(feedItem(b, 'route.txt')).toHaveCount(0);

  await openTab(b, 'Settings');
  await b.getByLabel('Circle passphrase').fill('blue lantern 7');
  await b.getByRole('button', { name: 'Apply' }).click();
  await openTab(b, 'Feed');
  await expect(feedItem(b, 'Meet at the library')).toBeVisible();
  await expect(feedItem(b, 'route.txt').getByRole('link', { name: 'Save file' })).toBeVisible();
  await expect(feedItem(b, 'Sealed for a circle you are not in')).toHaveCount(0);
  await proof(b, 'circle-reopen');
});

test('a beacon at the shelter desk posts notices under its own name and lists who checked in', async ({ context }) => {
  const beacon = await context.newPage();
  await joinAir(beacon, '/beacon.html?air=sim');
  const phone = await context.newPage();
  await joinAir(phone, '/?air=sim', 'Ana');

  const signAs = beacon.getByLabel('Sign as');
  await expect(signAs).toHaveValue('Beacon');
  await signAs.fill('Front desk');
  await beacon.getByRole('radio', { name: 'Water', exact: true }).click();
  await beacon.getByLabel('Notice', { exact: true }).fill('Drinking water in the gym until 18:00');
  await beacon.getByRole('button', { name: 'Post notice' }).click();
  await expect(beacon.getByRole('region', { name: 'Notices' })).toContainText('from Front desk');
  await expect(phone.getByRole('region', { name: 'Notices' })).toContainText('Drinking water in the gym until 18:00');
  await expect(phone.getByRole('region', { name: 'Notices' })).toContainText('from Front desk');

  await openTab(phone, 'Safety');
  await phone.getByRole('button', { name: 'I need help' }).click();
  await expect(checkInRow(beacon, 'Ana')).toContainText('Waiting for help');
  await expect(beacon.getByRole('heading', { name: /Check-ins · 1 person · 1 open request/ })).toBeVisible();
  await proof(beacon, 'beacon-desk');
});
