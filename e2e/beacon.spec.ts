import { airRow, expect, joinAir, nodeId, proof, sendText, stat, test } from './helpers';

test('a beacon hears a phone and relays its message one hop further', async ({ context }) => {
  const beacon = await context.newPage();
  await joinAir(beacon, '/beacon.html?air=sim');
  const phone = await context.newPage();
  await joinAir(phone);
  const id = await nodeId(phone);
  await expect(airRow(beacon, 'IN', `hello from ${id}`)).toBeVisible();
  const heard = await stat(beacon, 'Heard');

  await sendText(phone, 'Anyone near the east gate?');

  await expect(airRow(beacon, 'IN', `message from ${id}`)).toBeVisible();
  await expect.poll(() => stat(beacon, 'Heard')).toBeGreaterThan(heard);
  await expect(airRow(beacon, 'OUT', `message relayed for ${id}`)).toBeVisible();
  await expect.poll(() => stat(beacon, 'Relayed')).toBeGreaterThan(0);
  // The phone hears its own message come back from the beacon.
  await expect(airRow(phone, 'IN', 'echo of your message')).toBeVisible();
  await proof(beacon, 'beacon');
});
