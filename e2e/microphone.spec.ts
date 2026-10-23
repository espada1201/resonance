import { FAKE_MIC_PROFILES, FAKE_MIC_SENDER, FAKE_MIC_WAV, fakeMicBytes, fakeMicText } from './fake-mic';
import { airRow, expect, feedItem, openTab, proof, sendText, test } from './helpers';

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

test('a second tab of the same browser is sent to the first, and listens once that one closes', async ({ context }) => {
  const first = await context.newPage();
  await first.goto('/');
  await first.getByRole('button', { name: 'Start listening' }).click();
  await expect(first.getByRole('tab', { name: 'Feed' })).toBeVisible();
  const second = await context.newPage();
  await second.goto('/');
  await second.getByRole('button', { name: 'Start listening' }).click();
  await expect(second.getByRole('alert')).toHaveText('Resonance is already listening in another tab or window of this browser. Use that one, or close it, then try again.');
  await first.close();
  await second.getByRole('button', { name: 'Start listening' }).click();
  await expect(second.getByRole('tab', { name: 'Feed' })).toBeVisible();
});

test('a phone that pauses its sound says so, holds what you send, and a tap brings it back', async ({ page }) => {
  // What a locked screen or a call does to a page's audio: suspends it, and refuses it back until it is over.
  await page.addInitScript(() => {
    const Real = AudioContext;
    let held = false;
    const w = window as unknown as { lockScreen(): Promise<void>; unlockScreen(): void };
    window.AudioContext = class extends Real {
      constructor(options?: AudioContextOptions) {
        super(options);
        w.lockScreen = () => ((held = true), this.suspend());
        w.unlockScreen = () => void (held = false);
      }
      resume() {
        return held ? Promise.resolve() : super.resume();
      }
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start listening' }).click();
  await openTab(page, 'Settings');
  await page.getByRole('checkbox', { name: /Relay messages for others/ }).uncheck();
  const line = page.getByRole('region', { name: 'Sound', exact: true }).getByRole('status');
  await expect(line).not.toHaveText(/Starting/);

  await page.evaluate(() => (window as unknown as { lockScreen(): Promise<void> }).lockScreen());
  await expect(line).toHaveText(/^Sound paused by this device · tap to resume/);
  await sendText(page, 'Sent while the screen was locked');
  const item = feedItem(page, 'Sent while the screen was locked');
  await expect(item).toContainText('waiting to send…');
  await expect(line).toHaveText(/ · \d+ waiting$/);
  await proof(page, 'sound-paused');

  await page.evaluate(() => (window as unknown as { unlockScreen(): void }).unlockScreen());
  await line.click();
  await expect(line).not.toHaveText(/Sound paused/);
  await expect(item).not.toContainText('waiting to send');
  await expect(airRow(page, 'OUT', 'message')).toBeVisible();
});

test('a Bluetooth headset at 8 kHz is refused, the microphone let go, and listening starts once it is gone', async ({ page }) => {
  // A headset on its call codec runs the page's audio at 8 kHz. Note every microphone track handed out.
  await page.addInitScript(() => {
    const w = window as unknown as { headset: boolean; tracks: MediaStreamTrack[] };
    w.headset = true;
    w.tracks = [];
    const Real = AudioContext;
    window.AudioContext = class extends Real {
      constructor(options?: AudioContextOptions) {
        super(w.headset ? { ...options, sampleRate: 8000 } : options);
      }
    };
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await getUserMedia(constraints);
      w.tracks.push(...stream.getTracks());
      return stream;
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start listening' }).click();
  await expect(page.getByRole('alert')).toContainText('Disconnect the headset');
  // Not listening, so not recording: the browser's microphone light goes out.
  await expect.poll(() => page.evaluate(() => (window as unknown as { tracks: MediaStreamTrack[] }).tracks.map((t) => t.readyState))).toEqual(['ended']);

  await page.evaluate(() => void ((window as unknown as { headset: boolean }).headset = false));
  await page.getByRole('button', { name: 'Start listening' }).click();
  await expect(feedItem(page, /Hello from the fake microphone/).first()).toBeVisible();
});

test('a refused microphone says where to allow it again, and can be tried again', async ({ page }) => {
  // The browser's answer when someone has blocked the microphone for the site.
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start listening' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'The microphone is blocked for this page' })).toContainText('site settings beside the address bar');
  await expect(page.getByRole('button', { name: 'Start listening' })).toBeEnabled();
});
