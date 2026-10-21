import { FAKE_MIC_PROFILES, FAKE_MIC_SENDER, FAKE_MIC_WAV, fakeMicBytes, fakeMicText } from './fake-mic';
import { airRow, expect, feedItem, test } from './helpers';

// The real capture path: getUserMedia -> AudioWorklet -> demodulator worker -> mesh -> feed.
// Chromium's fake capture device plays a recording rendered by the app's own modulator (see
// global-setup.ts) as the microphone, on a loop: one message on each modem profile.

test.use({
  permissions: ['microphone'],
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${FAKE_MIC_WAV}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
});

for (const profile of FAKE_MIC_PROFILES) {
  test(`decodes the ${profile} message played into the microphone`, async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Start listening' }).click();

    const item = feedItem(page, fakeMicText(profile));
    await expect(item).toBeVisible();
    await expect(item).toContainText('fake mic');
    await expect(item).toContainText('heard directly');
    const size = new RegExp(`\\b${fakeMicBytes(profile)} B\\b`);
    await expect(airRow(page, 'IN', `message from ${process.env[FAKE_MIC_SENDER]}`, size)).toBeVisible();
  });
}
