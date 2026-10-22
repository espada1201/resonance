import { useState } from 'preact/hooks';
import { MAX_NICK } from '../mesh/payloads';
import { PROFILES, type ProfileId, rawBitrate } from '../modem/profiles';
import type { Station } from '../station';
import { fitInput } from './format';
import { Compass, Lock, Relay, Upload } from './icons';

const PROFILE_TEXT: Record<ProfileId, string> = {
  audible: 'Chirps you can hear. Carries across a room or down a corridor, through walls with the volume up.',
  fast: 'A short burst of hiss for devices close together in a quiet room. A full frame takes 1.2 s instead of 13 s, so a 4 KB photo crosses a small room in about a minute and a half instead of ten.',
  ultrasonic: 'Near the top of human hearing: quiet for most adults, short range, best for devices on the same table. Some speakers cannot play it.',
};

/** Rough, but the threat is real: anyone who records a sealed message can try guesses offline, at leisure. */
const guessable = (p: string) => p.length > 0 && p.length < 16 && p.split(/\s+/).length < 4;

export function Settings({ station }: { station: Station }) {
  const s = station.settings;
  const [pass, setPass] = useState(s.passphrase);
  const [show, setShow] = useState(false);
  const [deriving, setDeriving] = useState(false);
  const [passError, setPassError] = useState('');
  const [importMsg, setImportMsg] = useState('');
  const sealed = station.circleChannel !== null;

  const applyPass = async (e: Event) => {
    e.preventDefault();
    setDeriving(true);
    setPassError('');
    try {
      await station.setPassphrase(pass.trim());
    } catch {
      setPassError('This browser only encrypts on secure pages: open Resonance over https:// or on localhost.');
    } finally {
      setDeriving(false);
    }
  };

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    setImportMsg('Decoding…');
    try {
      const n = await station.importRecording(await file.arrayBuffer());
      setImportMsg(n ? `Found ${n} packet${n > 1 ? 's' : ''}. New ones are in your feed.` : 'No Resonance packets found in that recording.');
    } catch {
      setImportMsg('That file could not be decoded as audio.');
    }
  };

  return (
    <div class="settings">
      <label class="field">
        <span class="label">Nickname</span>
        <input value={s.nick} maxLength={MAX_NICK} placeholder="How others see you" onInput={(e) => station.update({ nick: fitInput(e, MAX_NICK) })} />
      </label>

      <fieldset class="field">
        <legend class="label">Transmit on</legend>
        {(Object.keys(PROFILES) as ProfileId[]).map((id) => (
          <label key={id} class="radio-card">
            <input type="radio" name="profile" checked={s.profile === id} onChange={() => station.update({ profile: id })} />
            <span>
              <strong>{PROFILES[id].label}</strong>
              <span class="muted small">
                {PROFILE_TEXT[id]} Raw rate {Math.round(rawBitrate(PROFILES[id]))} bit/s before error correction.
              </span>
            </span>
          </label>
        ))}
        <p class="muted small">This device always listens on all three.</p>
      </fieldset>

      <label class="field">
        <span class="label">Transmit volume · {Math.round(s.volume * 100)}%</span>
        <input type="range" min={0.1} max={1} step={0.05} value={s.volume} onInput={(e) => station.update({ volume: Number((e.target as HTMLInputElement).value) })} />
      </label>

      <label class="radio-card">
        <input type="checkbox" checked={s.relay} disabled={station.role === 'beacon'} onChange={(e) => station.update({ relay: (e.target as HTMLInputElement).checked })} />
        <span>
          <strong>
            <Relay size={16} /> Relay messages for others
          </strong>
          <span class="muted small">Your device repeats what it hears so messages reach people further away. It waits its turn and stays quiet when enough neighbours already repeated.</span>
        </span>
      </label>

      <label class="radio-card">
        <input type="checkbox" checked={s.answerFind} onChange={(e) => station.update({ answerFind: (e.target as HTMLInputElement).checked })} />
        <span>
          <strong>
            <Compass size={16} /> Answer distance requests
          </strong>
          <span class="muted small">Lets someone nearby use Find to measure how far away you are by timing chirps. Useful for being found; turn off if you would rather not be.</span>
        </span>
      </label>

      <form class="field" onSubmit={applyPass}>
        <span class="label">
          <Lock size={12} /> Circle passphrase
        </span>
        <div class="row">
          <input type={show ? 'text' : 'password'} value={pass} placeholder="Leave empty for open messages" autoComplete="off" aria-label="Circle passphrase" onInput={(e) => setPass((e.target as HTMLInputElement).value)} />
          <button type="button" class="ghost small" onClick={() => setShow(!show)}>
            {show ? 'Hide' : 'Show'}
          </button>
          <button type="submit" class="ghost small" disabled={deriving || pass.trim() === s.passphrase}>
            {deriving ? 'Deriving…' : 'Apply'}
          </button>
        </div>
        {guessable(pass.trim()) && (
          <span class="hint-warn small">Easy to guess. Anyone who records one sealed message can try passphrases offline; use four or more random words.</span>
        )}
        {passError && (
          <span class="error small" role="alert">
            {passError}
          </span>
        )}
        <span class="muted small">
          {sealed ? 'Your messages, check-ins, contacts and files are sealed with AES-256-GCM. ' : 'Messages are open. '}
          Everyone who types the same passphrase can read sealed messages; others relay them but see only “sealed”. Not hidden: which device sent what
          kind of packet, how big, when and to whom, and your nickname in hellos. Stored on this device only.
        </span>
      </form>

      <div class="field">
        <span class="label">Decode a recording</span>
        <label class="button ghost">
          <Upload size={16} /> Open an audio file
          <input type="file" accept="audio/*,.wav,.m4a,.mp3,.ogg,.webm" class="sr-only" onChange={(e) => void importFile((e.target as HTMLInputElement).files?.[0])} />
        </label>
        <span class="muted small">A voice memo, a voicemail or a radio recording that caught Resonance chirps. {importMsg}</span>
      </div>

      <div class="field">
        <span class="label">Leave a laptop as a relay</span>
        <a class="button ghost" href="beacon.html">
          <Relay size={16} /> Open beacon mode
        </a>
        <span class="muted small">A full-screen relay that keeps listening, repeats everything and hands stored messages to newcomers.</span>
      </div>

      <div class="field">
        <span class="label">Forget</span>
        <button
          type="button"
          class="ghost danger"
          onClick={() => {
            if (confirm('Forget every message, file and stored packet on this device?')) station.wipe();
          }}
        >
          Clear everything heard
        </button>
      </div>
    </div>
  );
}
