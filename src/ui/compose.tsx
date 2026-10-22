import { useState } from 'preact/hooks';
import { locate } from '../geo';
import { CHUNK_BYTES, MAX_FILE_BYTES } from '../mesh/files';
import { BROADCAST } from '../mesh/packet';
import { type Body, type Geo, MAX_CONTACT_NAME, MAX_CONTACT_PHONE, STATUSES, type Status, nowSec } from '../mesh/payloads';
import { airtimeSec } from '../modem/modulator';
import { PROFILES } from '../modem/profiles';
import type { Station } from '../station';
import { who } from './feed';
import { STATUS_TEXT, bytes, fitInput, seconds } from './format';
import { rovingKeys } from './hooks';
import { FileIcon, Lock, Pin, Send } from './icons';

type Mode = 'text' | 'checkin' | 'contact' | 'file';
const MODES: Array<[Mode, string]> = [
  ['text', 'Message'],
  ['checkin', 'Check in'],
  ['contact', 'Contact'],
  ['file', 'Tiny file'],
];
const MODE_IDS = MODES.map(([m]) => m);

/** Shrinks a photo to a JPEG small enough to cross the air in a few minutes. */
async function shrinkImage(file: File, maxBytes: number): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  for (const dim of [240, 192, 160, 128, 96, 72]) {
    const k = Math.min(1, dim / Math.max(bmp.width, bmp.height));
    canvas.width = Math.max(1, Math.round(bmp.width * k));
    canvas.height = Math.max(1, Math.round(bmp.height * k));
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    for (const q of [0.7, 0.55, 0.4, 0.28]) {
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', q));
      if (blob && blob.size <= maxBytes) return blob;
    }
  }
  throw new Error('That picture will not shrink enough to send.');
}

interface Picked {
  name: string;
  mime: string;
  data: Uint8Array;
  preview?: string;
}

export function Compose({ station, dst, setDst }: { station: Station; dst: number; setDst: (d: number) => void }) {
  const [mode, setMode] = useState<Mode>('text');
  const [text, setText] = useState('');
  const [status, setStatus] = useState<Status>('safe');
  const [note, setNote] = useState('');
  const [withGeo, setWithGeo] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [picked, setPicked] = useState<Picked | null>(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);

  const sealed = station.circleChannel !== null;
  // Check-ins feed everyone's safety map, and files go to everyone; only messages and contacts go to one person.
  const toEveryone = mode === 'checkin' || mode === 'file';
  const profile = PROFILES[station.settings.profile];
  const budget = station.textBudget();
  const used = new TextEncoder().encode(text).length;

  let preview: Body | null = null;
  if (mode === 'text') preview = { kind: 'text', ts: nowSec(), nick: station.settings.nick, text };
  if (mode === 'checkin') preview = { kind: 'checkin', ts: nowSec(), nick: station.settings.nick, status, note, geo: withGeo ? { lat: 0, lon: 0, accuracyM: 0 } : undefined };
  if (mode === 'contact') preview = { kind: 'contact', ts: nowSec(), name, phone, note };
  const fileSeconds = picked ? (Math.ceil(picked.data.length / CHUNK_BYTES) + 1) * airtimeSec(profile, Math.min(255, CHUNK_BYTES + 30)) : 0;
  const eta = mode === 'file' ? fileSeconds : preview ? station.estimateAirtime(preview) : 0;

  const canSend =
    station.status === 'listening' &&
    !working &&
    ((mode === 'text' && text.trim() && used <= budget) || mode === 'checkin' || (mode === 'contact' && name.trim()) || (mode === 'file' && picked));

  async function pick(file: File | undefined) {
    setError('');
    setPicked(null);
    if (!file) return;
    try {
      let blob: Blob = file;
      if (file.type.startsWith('image/') && file.size > MAX_FILE_BYTES) blob = await shrinkImage(file, MAX_FILE_BYTES - 200);
      if (blob.size > MAX_FILE_BYTES) throw new Error(`Files must be under ${bytes(MAX_FILE_BYTES)}. Sound is slow: this is a lifeline, not a cloud drive.`);
      const data = new Uint8Array(await blob.arrayBuffer());
      const mime = blob.type || file.type || 'application/octet-stream';
      const base = file.name.replace(/\.[^.]+$/, '');
      setPicked({ name: blob === file ? file.name : `${base}.jpg`, mime, data, preview: mime.startsWith('image/') ? URL.createObjectURL(blob) : undefined });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function submit(e: Event) {
    e.preventDefault();
    if (!canSend) return;
    setWorking(true);
    setError('');
    try {
      const target = dst === BROADCAST || toEveryone ? undefined : dst;
      if (mode === 'text') {
        await station.sendText(text.trim(), target);
        setText('');
      } else if (mode === 'checkin') {
        let geo: Geo | undefined;
        if (withGeo) {
          geo = await locate();
          station.setPosition(geo);
        }
        await station.sendCheckIn(status, note.trim(), geo);
        setNote('');
      } else if (mode === 'contact') {
        await station.sendContact(name.trim(), phone.trim(), note.trim(), target);
        setName('');
        setPhone('');
        setNote('');
      } else if (picked) {
        await station.sendFile(picked.name, picked.mime, picked.data);
        setPicked(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  }

  const neighbors = [...station.mesh.neighbors.values()];

  return (
    <form class="compose" onSubmit={submit} aria-label="Compose">
      <div class="seg" role="radiogroup" aria-label="What to send" onKeyDown={rovingKeys(MODE_IDS, mode, setMode)}>
        {MODES.map(([m, label]) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} tabIndex={mode === m ? 0 : -1} onClick={() => setMode(m)}>
            {label}
          </button>
        ))}
      </div>

      {mode === 'text' && (
        <label class="field grow">
          <span class="sr-only">Message</span>
          <textarea
            rows={2}
            value={text}
            placeholder={dst === BROADCAST ? 'Say something to everyone in earshot…' : `Say something to ${who(station, dst)}…`}
            onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submit(e);
              }
            }}
          />
        </label>
      )}

      {mode === 'checkin' && (
        <div class="checkin-fields">
          <div class="pills" role="radiogroup" aria-label="Status" onKeyDown={rovingKeys(STATUSES, status, setStatus)}>
            {STATUSES.map((s) => (
              <button key={s} type="button" role="radio" aria-checked={status === s} tabIndex={status === s ? 0 : -1} class={`pill s-${s}`} onClick={() => setStatus(s)}>
                {STATUS_TEXT[s]}
              </button>
            ))}
          </div>
          <input value={note} maxLength={80} placeholder="Short note (optional): where you are, what you need" aria-label="Note" onInput={(e) => setNote((e.target as HTMLInputElement).value)} />
          <label class="toggle">
            <input type="checkbox" checked={withGeo} onChange={(e) => setWithGeo((e.target as HTMLInputElement).checked)} />
            <Pin size={14} /> Attach my GPS position
          </label>
        </div>
      )}

      {mode === 'contact' && (
        <div class="grid2">
          <input value={name} placeholder="Name" aria-label="Name" maxLength={MAX_CONTACT_NAME} onInput={(e) => setName(fitInput(e, MAX_CONTACT_NAME))} />
          <input value={phone} placeholder="Phone" aria-label="Phone" inputMode="tel" maxLength={MAX_CONTACT_PHONE} onInput={(e) => setPhone(fitInput(e, MAX_CONTACT_PHONE))} />
          <input class="span2" value={note} placeholder="Note: role, skills, where to find you" aria-label="Contact note" maxLength={120} onInput={(e) => setNote((e.target as HTMLInputElement).value)} />
        </div>
      )}

      {mode === 'file' && (
        <div class="file-pick">
          <label class="button ghost">
            <FileIcon size={16} /> Choose a file or photo
            <input type="file" class="sr-only" onChange={(e) => void pick((e.target as HTMLInputElement).files?.[0])} />
          </label>
          {picked ? (
            <span class="picked">
              {picked.preview && <img src={picked.preview} alt="" />}
              {picked.name} · {bytes(picked.data.length)}
            </span>
          ) : (
            <span class="muted small">Up to {bytes(MAX_FILE_BYTES)}. Photos are shrunk automatically.</span>
          )}
        </div>
      )}

      <div class="compose-foot">
        <label class="to">
          <span class="label">To</span>
          <select value={String(toEveryone ? BROADCAST : dst)} onChange={(e) => setDst(Number((e.target as HTMLSelectElement).value))} disabled={toEveryone}>
            <option value={String(BROADCAST)}>Everyone</option>
            {neighbors.map((n) => (
              <option key={n.id} value={String(n.id)}>
                {who(station, n.id, n.nick)}
              </option>
            ))}
            {dst !== BROADCAST && !station.mesh.neighbors.has(dst) && <option value={String(dst)}>{who(station, dst)}</option>}
          </select>
        </label>
        <span class="budget small">
          {mode === 'text' && <span class={used > budget ? 'over' : ''}>{budget - used} bytes left · </span>}
          {eta > 0 && <>≈ {seconds(eta)} on air</>}
          {sealed && (
            <span class="sealed-note">
              {' '}
              · <Lock size={12} /> sealed
            </span>
          )}
        </span>
        <button type="submit" class="primary" disabled={!canSend}>
          <Send size={16} /> {working ? 'Sending…' : 'Send'}
        </button>
      </div>
      {mode === 'text' && used > budget && (
        <p class="error small">
          <span role="alert">Too long for one sound packet.</span> It holds {budget} bytes; trim {used - budget}.
        </p>
      )}
      {error && (
        <p class="error small" role="alert">
          {error}
        </p>
      )}
      {station.status !== 'listening' && <p class="muted small">Start listening first: Resonance needs the speaker and microphone.</p>}
    </form>
  );
}
