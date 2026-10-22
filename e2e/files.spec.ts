import { chunkFile } from '../src/mesh/files';
import { PacketType, randomNodeId } from '../src/mesh/packet';
import { encodeBody } from '../src/mesh/payloads';
import { expect, feedItem, joinAir, openTab, playPacket, proof, test } from './helpers';

// A 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
// The header of a lossless WebP of 16383×16383 pixels: drawn, these 25 bytes would ask for a gigabyte.
const HUGE = Buffer.from('UklGRhEAAABXRUJQVlA4TAUAAAAv/r//Dw==', 'base64');

test('picking another photo lets go of the last preview', async ({ page }) => {
  // A preview is an object URL, and one never revoked keeps its photo in memory until the page closes.
  await page.addInitScript(() => {
    const revoke = URL.revokeObjectURL;
    const revoked: string[] = [];
    Object.assign(window, { revoked });
    URL.revokeObjectURL = (url) => {
      revoked.push(url);
      revoke(url);
    };
  });
  await page.goto('/?air=sim');
  await page.getByRole('radio', { name: 'Tiny file', exact: true }).click();
  const choose = page.getByLabel('Choose a file or photo');
  const preview = (name: string) => page.getByText(`${name} · ${PNG.length} B`).locator('img');
  await choose.setInputFiles({ name: 'stairwell.png', mimeType: 'image/png', buffer: PNG });
  const first = await preview('stairwell.png').getAttribute('src');
  await choose.setInputFiles({ name: 'exit.png', mimeType: 'image/png', buffer: PNG });
  await expect(preview('exit.png')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { revoked: string[] }).revoked)).toEqual([first]);
  await proof(page, 'photo-preview');
});

test('a picture heard over the air is drawn, unless its header asks for more pixels than a phone should decode', async ({ page }) => {
  await joinAir(page);
  // Relaying each piece would talk over the next.
  await openTab(page, 'Settings');
  await page.getByRole('checkbox', { name: /Relay messages for others/ }).uncheck();
  await openTab(page, 'Feed');
  const src = randomNodeId();
  for (const [fileId, name, mime, data] of [[1, 'exit.png', 'image/png', PNG], [2, 'huge.webp', 'image/webp', HUGE]] as const) {
    const chunks = chunkFile(fileId, { name, mime }, data);
    for (const [i, chunk] of chunks.entries()) {
      await playPacket(page, PacketType.FileChunk, encodeBody(chunk), src);
      await expect(feedItem(page, name)).toContainText(`${i + 1}/${chunks.length} pieces`);
    }
  }
  await expect(feedItem(page, 'exit.png').getByRole('img', { name: 'exit.png' })).toBeVisible();
  const huge = feedItem(page, 'huge.webp');
  await expect(huge).toContainText('Too large to preview.');
  await expect(huge.getByRole('img')).toHaveCount(0);
  await expect(huge.getByRole('link', { name: 'Save file' })).toBeVisible();
  await proof(page, 'picture-too-large');
});
