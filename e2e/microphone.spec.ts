import { FAKE_MIC_PROFILES, FAKE_MIC_SENDER, FAKE_MIC_WAV, fakeMicBytes, fakeMicText } from './fake-mic';
import { airRow, expect, feedItem, openTab, proof, test } from './helpers';

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

/** How the air log names each mode. */
const MODE_LABEL = { audible: 'audible', fast: 'fast', ultrasonic: 'quiet' };

for (const profile of FAKE_MIC_PROFILES) {
  test(`decodes the ${profile} message played into the microphone`, async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Start listening' }).click();
    // A station is deaf while it transmits and the recording keeps looping: relaying what it
    // decodes would mask whole passes of the loop. Off before the first frame decodes (~5 s).
    await openTab(page, 'Settings');
    await page.getByRole('checkbox', { name: /Relay messages for others/ }).uncheck();
    await openTab(page, 'Feed');

    const item = feedItem(page, fakeMicText(profile));
    await expect(item).toBeVisible();
    await expect(item).toContainText('fake mic');
    await expect(item).toContainText('heard directly');
    const modeAndSize = new RegExp(`${MODE_LABEL[profile]} · ${fakeMicBytes(profile)} B\\b`);
    await expect(airRow(page, 'IN', `message from ${process.env[FAKE_MIC_SENDER]}`, modeAndSize)).toBeVisible();
    await proof(page, `microphone-${profile}`);
  });
}
