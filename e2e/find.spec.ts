import { expect, joinAir, nodeId, openTab, test } from './helpers';

// Find mode times chirps both ways between two devices. The simulated room delays each tab's
// sound by distance / 343 m/s, so two tabs standing 3.2 m apart should read about 3.2 m.

test('Find measures the distance to a neighbour by sound', async ({ context }) => {
  const a = await context.newPage();
  await joinAir(a, '/?air=sim&at=0,0', 'Ana');
  const b = await context.newPage();
  await joinAir(b, '/?air=sim&at=3.2,0', 'Ben');
  const ben = `#${await nodeId(b)}`;

  await openTab(a, 'People');
  const row = a.getByRole('listitem').filter({ hasText: ben });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: /^Find / }).click();

  const readout = a.getByRole('region', { name: /^Distance to / }).getByText(/^[\d.]+\s*m$/);
  // Metres to two decimals: anything from 3.00 to 3.40 passes.
  await expect(readout).toHaveText(/^3\.([0-3]\d|40)\s*m$/, { timeout: 45_000 });
});
