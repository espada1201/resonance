import { FAKE_MIC_TEXT, fakeMicSenderVar, fakeMicWav } from './fake-mic';
import { airRow, expect, feedItem, test } from './helpers';

// The real capture path: getUserMedia -> AudioWorklet -> demodulator worker -> mesh -> feed.
// Chromium's fake capture device plays a WAV rendered by the app's own modulator (see
// global-setup.ts) as the microphone, on a loop.

for (const profile of ['audible', 'ultrasonic'] as const) {
  test.describe(`microphone, ${profile} band`, () => {
    test.use({
      permissions: ['microphone'],
      launchOptions: {
        args: [
          '--use-fake-ui-for-media-stream',
          '--use-fake-device-for-media-stream',
          `--use-file-for-fake-audio-capture=${fakeMicWav(profile)}`,
          '--autoplay-policy=no-user-gesture-required',
        ],
      },
    });

    test('decodes a packet played into the microphone', async ({ page }) => {
      await page.goto('/');
      await page.getByRole('button', { name: 'Start listening' }).click();

      const item = feedItem(page, FAKE_MIC_TEXT[profile]);
      await expect(item).toBeVisible();
      await expect(item).toContainText('fake mic');
      await expect(item).toContainText('heard directly');
      await expect(airRow(page, 'IN', `message from ${process.env[fakeMicSenderVar(profile)]}`)).toBeVisible();
    });
  });
}
