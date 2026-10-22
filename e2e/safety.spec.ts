import { readFile } from 'node:fs/promises';
import { checkInRow, expect, feedItem, joinAir, openTab, proof, sendText, test } from './helpers';

// The jobs people have when the network is down: say how you are and what you need, see who
// needs help and answer them, get word to family outside, and tell everyone nearby what matters.

test('a call for help travels with its details, gets an answer, and closes when they are safe', async ({ context }) => {
  test.setTimeout(240_000);
  const a = await context.newPage();
  await joinAir(a);
  const b = await context.newPage();
  await joinAir(b, '/?air=sim', 'Ben');

  await openTab(a, 'Safety');
  await a.getByLabel('Your name').fill('Ana');
  await a.getByText('More detail').click();
  await a.getByRole('radio', { name: 'Needs help' }).click();
  await a.getByRole('button', { name: 'Trapped' }).click();
  await a.getByRole('button', { name: 'Water' }).click();
  await a.getByLabel('Where', { exact: true }).fill('Floor 4, room 412');
  await a.getByRole('button', { name: 'Send check-in' }).click();

  await openTab(b, 'Safety');
  const ana = checkInRow(b, 'Ana');
  await expect(ana).toContainText('Waiting for help');
  await expect(ana).toContainText('Trapped');
  await expect(ana).toContainText('Floor 4, room 412');
  await expect(b.getByRole('tab', { name: 'Safety, 1 open request' })).toBeVisible();
  await ana.getByRole('button', { name: 'On my way' }).click();
  await expect(ana).toContainText('You are on the way');

  await expect(checkInRow(a, 'You')).toContainText('Ben is on the way');
  await a.getByRole('button', { name: "I'm safe" }).click();
  await expect(ana).toContainText('Safe');
  await expect(ana).not.toContainText('Waiting for help');
  await expect(b.getByRole('tab', { name: 'Safety', exact: true })).toBeVisible();
  await proof(b, 'call-for-help');
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
  expect(csv.split('\r\n')[0]).toBe('Name,Reported by,Status,Request,Needs,Place,Note,Latitude,Longitude,Accuracy (m),Sent (UTC),Hops,Replies,Outside contact');
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
