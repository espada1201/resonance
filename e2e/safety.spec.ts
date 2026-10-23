import { readFile } from 'node:fs/promises';
import { airRow, checkInRow, expect, feedItem, joinAir, nodeId, openTab, proof, sendText, test } from './helpers';

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
  await expect(b.getByRole('tab', { name: 'Safety, 1 waiting for you' })).toBeVisible();
  // Unanswered: the heading says someone is asking and that it is waiting for this phone.
  await expect(b.getByRole('heading', { name: 'Check-ins · 1 person · 1 asking for help · 1 waiting for you' })).toBeVisible();
  await ana.getByRole('button', { name: 'On my way' }).click();
  await expect(ana).toContainText('You are on the way');
  await expect(ana).toContainText('heard by a phone nearby');
  // Ben has answered it, so it is nothing more for him to act on and the count goes, but the heading still says a person is asking.
  await expect(b.getByRole('tab', { name: 'Safety', exact: true })).toBeVisible();
  await expect(b).toHaveTitle('Resonance');
  await expect(b.getByRole('heading', { name: 'Check-ins · 1 person · 1 asking for help · you are on your way to 1' })).toBeVisible();
  await expect(a.getByRole('heading', { name: 'Check-ins · 1 person · 1 asking for help · someone is coming to you' })).toBeVisible();

  await expect(checkInRow(a, 'You')).toContainText('Ben is on the way');
  await expect(checkInRow(a, 'You')).not.toContainText('heard from their own phone');
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
  // Nobody asking: the third state of the heading.
  await expect(b.getByRole('heading', { name: 'Check-ins · 1 person · no one is asking for help' })).toBeVisible();
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
  await expect(page.getByRole('tab', { name: 'Safety', exact: true })).toBeVisible();
  await expect(page.locator('.tabs .badge')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Check-ins · 1 person · 1 asking for help · you are waiting for someone' })).toBeVisible();
  await expect(page).toHaveTitle('Resonance');
  await expect(airRow(page, 'OUT', 'check-in')).toBeVisible({ timeout: 8_000 });
  // Its rows hold nothing to tab to, so the log itself takes focus for the keyboard to scroll it.
  await expect(page.getByRole('region', { name: 'Sound log' })).toHaveAttribute('tabindex', '0');
  await proof(page, 'help-without-fix');
});

test('a check-in from the compose bar goes out without a position when GPS fails', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.geolocation.getCurrentPosition = (_found, failed) => setTimeout(() => failed?.({ code: 2 } as GeolocationPositionError));
  });
  await joinAir(page, '/?air=sim', 'Ana');
  await page.getByRole('radio', { name: 'Check in', exact: true }).click();
  await page.getByText('Someone without a phone, family outside, GPS').click();
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
  await expect(a.getByText('Waiting to send…')).toBeVisible();
  await expect(a.getByText('Sent. Heard by a phone nearby. No one has said they are coming yet.')).toBeVisible();

  await openTab(b, 'Safety');
  const ana = checkInRow(b, 'Ana');
  await expect(ana).toContainText('Trapped');
  await expect(ana).toContainText('Leg stuck under a beam');
  await ana.getByRole('button', { name: 'On my way' }).click();
  await expect(a.getByText(/^Sent\.( Heard by a phone nearby\.)? Ben is on the way\.$/)).toBeVisible();
  await proof(a, 'big-button-details');
});

test('a call for help in the feed is answered from the feed', async ({ context }) => {
  const a = await context.newPage();
  await joinAir(a, '/?air=sim', 'Ana');
  const b = await context.newPage();
  await joinAir(b, '/?air=sim', 'Ben');

  await openTab(a, 'Safety');
  await a.getByRole('button', { name: 'I need help' }).click();
  const request = feedItem(b, 'Needs help');
  await request.getByRole('button', { name: 'On my way' }).click();
  await expect(request).toContainText('You are on the way');
  await expect(request).toContainText(/You are on the way · .+ · heard by a phone nearby/);
  await expect(request.getByRole('button', { name: 'On my way' })).toHaveCount(0);
  // The button that was pressed is gone; the keyboard lands on the next one, not back at the top.
  await expect(request.getByRole('button', { name: 'Save as audio' })).toBeFocused();
  await expect(checkInRow(a, 'You')).toContainText('Ben is on the way');
  await proof(b, 'on-my-way-from-feed');
});

test('a check-in sent without a name goes at once, then asks for the name with the box ready, and sends again with it', async ({ page }) => {
  await joinAir(page);
  await openTab(page, 'Safety');
  const id = await nodeId(page);
  await expect(page.getByText(`Without a name, others see you as #${id}.`)).toBeVisible();
  await page.getByRole('button', { name: "I'm safe" }).click();
  const status = page.getByRole('status').filter({ hasText: 'Sent' });
  await expect(status).toContainText(`Sent. Others see you as #${id}. Type your name in the box above, then send again.`);
  await expect(page.getByLabel('Your name')).toBeFocused();
  await page.keyboard.type('Ana');
  // The line stays until the next send: typing the name does not make it vanish under the person's fingers.
  await expect(page.getByLabel('Your name')).toHaveValue('Ana');
  await expect(status).toContainText(`Others see you as #${id}. Type your name in the box above, then send again.`);
  await page.getByRole('button', { name: "I'm safe" }).click();
  await expect(status).not.toContainText('Others see you');
  // It turned itself off while sending; the keyboard comes back to it, not to the top of the page.
  await expect(page.getByRole('button', { name: "I'm safe" })).toBeFocused();
  await page.getByRole('button', { name: 'I need help' }).click();
  await expect(page.getByText('Sent. No one has said they are coming yet. Add where you are and what you need, and send again.')).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Needs help' })).toBeChecked();
  await expect(page.getByLabel('Where', { exact: true })).toBeFocused();
  // The one tap sent a position; the details sent after it must not quietly drop it.
  await expect(page.getByLabel('Attach my GPS position')).toBeChecked();
});

test('a call for help without a name is never held back for one: it goes, then says how to add the name', async ({ context }) => {
  const a = await context.newPage();
  await joinAir(a);
  const b = await context.newPage();
  await joinAir(b, '/?air=sim', 'Ben');
  await openTab(a, 'Safety');
  const id = await nodeId(a);
  await a.getByRole('button', { name: 'I need help' }).click();
  // Where stays the first thing asked for in an emergency; the name is said beside it, not instead of it.
  await expect(a.getByRole('status').filter({ hasText: 'Sent' })).toContainText(`Others see you as #${id}. Type your name in the box above, then send again.`);
  await expect(a.getByLabel('Where', { exact: true })).toBeFocused();
  await expect(a.getByLabel('Your name')).toBeVisible();
  await expect(feedItem(b, 'Needs help')).toContainText(`#${id}`);
  await a.getByLabel('Your name').fill('Ana');
  await expect(a.getByRole('status').filter({ hasText: 'Sent' })).toContainText('Others see you');
  await a.getByRole('button', { name: "I'm safe" }).click();
  await expect(a.getByRole('status').filter({ hasText: 'Sent' })).not.toContainText('Others see you');
});

test('a call for help sent from the open form without a name leaves the keyboard off the name box, and "I\'m safe" still goes to it', async ({ page }) => {
  await joinAir(page);
  await openTab(page, 'Safety');
  const name = page.getByLabel('Your name');
  const status = page.getByRole('status').filter({ hasText: 'Sent' });
  await page.getByText('More detail').click();
  await page.getByRole('radio', { name: 'Needs medical help' }).click();
  await page.getByRole('button', { name: 'Send check-in' }).click();
  await expect(status).toContainText('Others see you as');
  await expect(name).not.toBeFocused();
  await expect(page.getByRole('button', { name: 'Send check-in' })).toBeFocused();

  await page.getByRole('button', { name: 'I need help' }).click();
  await expect(status).toContainText('Others see you as');
  await expect(name).not.toBeFocused();
  await expect(page.getByRole('button', { name: 'I need help' })).toBeFocused();

  await page.getByRole('button', { name: "I'm safe" }).click();
  await expect(status).toContainText('Others see you as');
  await expect(name).toBeFocused();
});

test('the first screen has I\'m safe and I need help, and they do what the Safety tab buttons do', async ({ context }) => {
  const a = await context.newPage();
  await joinAir(a, '/?air=sim', 'Ana');
  const b = await context.newPage();
  await joinAir(b, '/?air=sim', 'Ben');

  const shortcuts = a.getByRole('group', { name: 'In an emergency' });
  await shortcuts.getByRole('button', { name: "I'm safe" }).click();
  await expect(a.getByRole('tab', { name: 'Safety', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(a.getByRole('status').filter({ hasText: 'Sent' })).toContainText('Sent.');
  await openTab(b, 'Safety');
  await expect(checkInRow(b, 'Ana')).toContainText('Safe');

  await openTab(a, 'Feed');
  await shortcuts.getByRole('button', { name: 'I need help' }).click();
  await expect(a.getByRole('status').filter({ hasText: 'Sent' })).toContainText('No one has said they are coming yet. Add where you are and what you need, and send again.');
  await expect(a.getByLabel('Where', { exact: true })).toBeFocused();
  await expect(checkInRow(b, 'Ana')).toContainText('Waiting for help');
  await expect(shortcuts).toHaveCount(0);
});

test('a call for help sent by mistake from the first screen is taken back in one tap, and others see it resolved', async ({ context }) => {
  const a = await context.newPage();
  await joinAir(a, '/?air=sim', 'Ana');
  const b = await context.newPage();
  await joinAir(b, '/?air=sim', 'Ben');

  // One tap still sends at once: nothing asks "are you sure" first.
  await a.getByRole('group', { name: 'In an emergency' }).getByRole('button', { name: 'I need help' }).click();
  const status = a.getByRole('status').filter({ hasText: 'Sent' });
  await expect(status).toContainText('No one has said they are coming yet.');
  await expect(b.getByRole('tab', { name: 'Safety, 1 waiting for you' })).toBeVisible();
  await a.getByRole('button', { name: 'Sent by mistake? Take it back' }).click();
  await expect(a.getByRole('status').filter({ hasText: 'Taken back' })).toHaveText('Taken back. Others now see it as resolved.');
  await expect(a.getByRole('button', { name: 'Sent by mistake? Take it back' })).toHaveCount(0);
  await expect(a.getByRole('button', { name: 'I need help' })).toBeFocused();
  await expect(checkInRow(a, 'You')).toContainText('Resolved');

  await expect(b.getByRole('tab', { name: 'Safety', exact: true })).toBeVisible();
  await openTab(b, 'Safety');
  await expect(checkInRow(b, 'Ana')).toContainText('Resolved');
  await expect(checkInRow(b, 'Ana')).not.toContainText('Waiting for help');
  await proof(a, 'taken-back');
});

test('the one-tap help on the Safety tab offers the same way out, and a later check-in takes the offer away', async ({ page }) => {
  await joinAir(page, '/?air=sim', 'Ana');
  await openTab(page, 'Safety');
  await page.getByRole('button', { name: 'I need help' }).click();
  const takeBack = page.getByRole('button', { name: 'Sent by mistake? Take it back' });
  await expect(takeBack).toBeVisible();
  await page.getByRole('button', { name: "I'm safe" }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Sent' })).toContainText('Sent.');
  await expect(takeBack).toHaveCount(0);
});

test('a double tap on the first screen\'s help button cannot send a second, contradicting check-in', async ({ context }) => {
  const a = await context.newPage();
  await joinAir(a, '/?air=sim', 'Ana');
  const b = await context.newPage();
  await joinAir(b, '/?air=sim', 'Ben');

  // The second tap lands on Safety's own row as soon as it can be pressed. This needs the clock of a real tap, so it runs in the page.
  const waited = await a.evaluate(async () => {
    const button = (selector: string) => document.querySelector<HTMLButtonElement>(selector);
    const t0 = performance.now();
    button('.shortcuts .s-help')!.click();
    // Safety's row is pressable again only once the first tap has been sent and its answer shown.
    while (!button('.checkin-card [role="status"]') || button('.quick .s-safe')?.disabled !== false) await new Promise((r) => setTimeout(r, 0));
    const waited = performance.now() - t0;
    button('.quick .s-safe')!.click();
    return waited;
  });
  expect(waited, 'the second tap came within the guard window').toBeLessThan(400);

  // A check-in sent by the second tap would take a moment to show; give it that, then look.
  await a.waitForTimeout(1500);
  await expect(a.getByRole('status').filter({ hasText: 'Sent' })).toContainText('No one has said they are coming yet.');
  await expect(checkInRow(a, 'You')).toContainText('Waiting for help');
  await openTab(b, 'Safety');
  await expect(checkInRow(b, 'Ana')).toContainText('Waiting for help');

  // After the moment has passed, the same button works.
  await a.getByRole('button', { name: "I'm safe" }).click();
  await expect(checkInRow(a, 'You')).toContainText('Safe');
});

test('a check-in keeps the status sent but not its needs, and the keyboard meets its fields in the order they are typed', async ({ page }) => {
  await joinAir(page, '/?air=sim', 'Ana');
  await page.getByRole('radio', { name: 'Check in', exact: true }).click();
  await page.getByRole('radio', { name: 'Needs medical help' }).click();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Where', { exact: true })).toBeFocused();
  await page.keyboard.type('Dark stairs');
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Note')).toBeFocused();
  await page.keyboard.type('Hurt ankle');
  await page.keyboard.press('Tab');
  // The needs are one stop: arrows move along them, Space switches one on, Tab goes on past them all.
  const needs = page.getByRole('toolbar', { name: 'What is needed' });
  await expect(needs.getByRole('button').first()).toBeFocused();
  const hint = page.getByText('Arrow keys move, Space picks');
  await expect(hint).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(needs.getByRole('button', { name: 'Injured' })).toBeFocused();
  await page.keyboard.press('Space');
  await expect(needs.getByRole('button', { name: 'Injured' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Tab');
  await expect(page.getByText('Someone without a phone, family outside, GPS')).toBeFocused();
  await expect(hint).toBeHidden();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(airRow(page, 'OUT', 'check-in')).toBeVisible({ timeout: 8_000 });
  await expect(page.getByLabel('Note')).toBeEmpty();
  await expect(page.getByRole('radio', { name: 'Needs medical help' })).toBeChecked();
  await expect(page.getByRole('button', { name: 'Injured' })).toHaveAttribute('aria-pressed', 'false');
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
    await b.getByText('Someone without a phone, family outside, GPS').click();
    await b.getByLabel('Family outside: phone or email').fill('+1 (555) 010-0199');
    await b.getByRole('button', { name: 'Send check-in' }).click();
    await openTab(a, 'Safety');
    const ben = a.getByRole('region', { name: /^Check-ins/ }).getByRole('listitem').first();
    await expect(ben).toContainText('Ben');

    await openTab(a, 'Feed');
    await a.getByRole('radio', { name: 'Check in', exact: true }).click();
    await a.getByText('Someone without a phone, family outside, GPS').click();
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
  await a.getByText('Someone without a phone, family outside, GPS').click();
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
  await a.getByText('Someone without a phone, family outside, GPS').click();
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
  const chunks = b.getByRole('list', { name: 'Sound activity' }).getByRole('listitem').filter({ hasText: 'file chunk from' });
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
  await expect(beacon.getByRole('heading', { name: /Check-ins · 1 person · 1 asking for help/ })).toBeVisible();
  await proof(beacon, 'beacon-desk');
});
