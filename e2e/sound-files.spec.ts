import { expect, feedItem, joinAir, openTab, proof, sendText, test } from './helpers';

// Any speaker can carry a packet: a message saved as a WAV decodes on a device that only ever
// hears the recording.

test('a message saved as a sound file decodes on a device that never heard it', async ({ context }) => {
  const text = 'Generator fuel is in the blue shed';
  const a = await context.newPage();
  await joinAir(a);
  await sendText(a, text);
  const [download] = await Promise.all([a.waitForEvent('download'), feedItem(a, text).getByRole('button', { name: 'Sound file' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^resonance-[0-9A-F]{6}-[0-9a-f]+\.wav$/);
  const wav = await download.path();
  // Simulated air keeps nothing between pages, so with the sender gone the message exists only in the file.
  await a.close();

  const b = await context.newPage();
  await joinAir(b);
  await openTab(b, 'Settings');
  await b.getByLabel('Open an audio file').setInputFiles(wav);
  await expect(b.getByText('Found 1 packet. New ones are in your feed.')).toBeVisible();
  await openTab(b, 'Feed');
  await expect(feedItem(b, text)).toBeVisible();
  await proof(b, 'decoded');
});
