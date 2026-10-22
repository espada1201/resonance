import { useEffect, useState } from 'preact/hooks';
import { MAX_FILE_BYTES } from '../mesh/files';
import { BROADCAST } from '../mesh/packet';
import { MAX_CONTACT_NAME, MAX_CONTACT_PHONE, SKILLS, type Skill } from '../mesh/payloads';
import type { Draft, Station } from '../station';
import { ANY_FIX, CheckInFields, type CheckInDraft, NameField, checkInFix, draftFields, draftProblem, newDraft } from './checkin-form';
import { who } from './feed';
import { SKILL_TEXT, bytes, errorText, fitInput, seconds } from './format';
import { rovingKeys } from './hooks';
import { FileIcon, Lock, Send } from './icons';
import { NoticeFields, type NoticeDraft, newNotice } from './notices';

type Mode = 'text' | 'checkin' | 'notice' | 'contact' | 'file';
const MODES: Array<[Mode, string]> = [
  ['text', 'Message'],
  ['checkin', 'Check in'],
  ['notice', 'Notice'],
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

interface ContactDraft {
  name: string;
  phone: string;
  note: string;
  skills: Skill[];
}

/** Where the keyboard goes in the composer: the message box, else the choice of what to send. */
export function focusCompose() {
  const field = document.querySelector<HTMLElement>('#compose textarea') ?? document.querySelector<HTMLElement>('#compose [role="radio"][aria-checked="true"]');
  field?.focus();
}

interface ComposeProps {
  station: Station;
  dst: number;
  setDst: (d: number) => void;
  /** Someone asked to write to `dst` (Reply, Message): open the message box, put the keyboard in it, then call `wrote`. */
  writing: boolean;
  wrote: () => void;
}

export function Compose({ station, dst, setDst, writing, wrote }: ComposeProps) {
  const [mode, setMode] = useState<Mode>('text');
  const [text, setText] = useState('');
  const [checkin, setCheckin] = useState<CheckInDraft>(() => newDraft(station.settings));
  const [notice, setNotice] = useState<NoticeDraft>(newNotice);
  const [contact, setContact] = useState<ContactDraft>({ name: '', phone: '', note: '', skills: [] });
  const [picked, setPicked] = useState<Picked | null>(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [said, setSaid] = useState('');
  useEffect(() => {
    if (!writing) return;
    setMode('text');
    requestAnimationFrame(focusCompose);
    wrote();
  }, [writing]);
  // A picked photo's preview lives until another is picked or it is sent.
  useEffect(() => () => void (picked?.preview && URL.revokeObjectURL(picked.preview)), [picked?.preview]);

  const sealed = station.circleChannel !== null;
  // Check-ins feed everyone's safety list, notices everyone's board, and files go to everyone; only messages and contacts go to one person.
  const toEveryone = mode === 'checkin' || mode === 'notice' || mode === 'file';

  // One draft drives the bytes left, the time on air and the send, so what is measured is what goes.
  let draft: Draft | null = null;
  if (mode === 'text') draft = { kind: 'text', text };
  if (mode === 'checkin') draft = { kind: 'checkin', ...draftFields(checkin, checkin.withGeo ? ANY_FIX : undefined) };
  if (mode === 'notice') draft = { kind: 'notice', ...notice };
  if (mode === 'contact') draft = { kind: 'contact', ...contact };
  const cost = draft ? station.budget(draft) : null;
  const room = cost?.left ?? 0;
  const eta = mode === 'file' ? (picked ? station.fileSeconds(picked.data.length) : 0) : (cost?.seconds ?? 0);
  const filled =
    (mode === 'text' && text.trim()) ||
    mode === 'checkin' ||
    (mode === 'notice' && notice.text.trim()) ||
    (mode === 'contact' && contact.name.trim()) ||
    (mode === 'file' && picked);
  const canSend = station.status === 'listening' && !working && !!filled && (mode === 'file' || room >= 0);

  async function pick(file: File | undefined) {
    setError('');
    setPicked(null);
    if (!file) return;
    try {
      let blob: Blob = file;
      if (file.type.startsWith('image/') && file.size > MAX_FILE_BYTES) blob = await shrinkImage(file, MAX_FILE_BYTES - 200);
      if (blob.size > MAX_FILE_BYTES) throw new Error(`Sound is slow, so files must be ${bytes(MAX_FILE_BYTES)} or smaller.`);
      const data = new Uint8Array(await blob.arrayBuffer());
      const mime = blob.type || file.type || 'application/octet-stream';
      const base = file.name.replace(/\.[^.]+$/, '');
      setPicked({ name: blob === file ? file.name : `${base}.jpg`, mime, data, preview: mime.startsWith('image/') ? URL.createObjectURL(blob) : undefined });
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function submit(e: Event) {
    e.preventDefault();
    if (!canSend) return;
    const problem = mode === 'checkin' ? draftProblem(checkin) : null;
    if (problem) return setError(problem);
    setWorking(true);
    setError('');
    setSaid('');
    try {
      const target = dst === BROADCAST ? undefined : dst;
      if (mode === 'text') {
        await station.say({ kind: 'text', text: text.trim() }, target);
        setText('');
      } else if (mode === 'checkin') {
        const geo = checkin.withGeo ? await checkInFix(station, setError) : undefined;
        await station.say({ kind: 'checkin', ...draftFields(checkin, geo) });
        // The status stays as sent: after a call for help, the form must not quietly say Safe.
        setCheckin((d) => newDraft(station.settings, d.status));
      } else if (mode === 'notice') {
        await station.say({ kind: 'notice', ...notice, place: notice.place.trim(), text: notice.text.trim() });
        setNotice(newNotice());
      } else if (mode === 'contact') {
        const { name, phone, note, skills } = contact;
        await station.say({ kind: 'contact', name: name.trim(), phone: phone.trim(), note: note.trim(), skills: skills.length ? skills : undefined }, target);
        setContact({ name: '', phone: '', note: '', skills: [] });
      } else if (picked) {
        await station.sendFile(picked.name, picked.mime, picked.data);
        setPicked(null);
      }
      setSaid(dst === BROADCAST || toEveryone ? 'Sent to everyone in earshot.' : `Sent to ${who(station, dst)}.`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setWorking(false);
      // Send turned itself off while sending, which drops the keyboard on the page: bring it back.
      if (document.activeElement === document.body || !document.activeElement) focusCompose();
    }
  }

  const neighbors = [...station.mesh.neighbors.values()];
  const noteMax = room + new TextEncoder().encode(contact.note).length;
  const toggleSkill = (s: Skill) => setContact((c) => ({ ...c, skills: c.skills.includes(s) ? c.skills.filter((x) => x !== s) : [...c.skills, s] }));

  return (
    <form class="compose" id="compose" onSubmit={submit} aria-label="Compose">
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
        <>
          <NameField station={station} />
          <CheckInFields draft={checkin} set={(p) => setCheckin((d) => ({ ...d, ...p }))} room={room} />
        </>
      )}

      {mode === 'notice' && <NoticeFields draft={notice} set={(p) => setNotice((d) => ({ ...d, ...p }))} room={room} />}

      {mode === 'contact' && (
        <div class="grid2">
          <input value={contact.name} placeholder="Name" aria-label="Name" onInput={(e) => setContact((c) => ({ ...c, name: fitInput(e, MAX_CONTACT_NAME) }))} />
          <input value={contact.phone} placeholder="Phone" aria-label="Phone" inputMode="tel" onInput={(e) => setContact((c) => ({ ...c, phone: fitInput(e, MAX_CONTACT_PHONE) }))} />
          <div class="pills span2" role="group" aria-label="I can help with">
            {SKILLS.map((s) => (
              <button key={s} type="button" class="pill need" aria-pressed={contact.skills.includes(s)} onClick={() => toggleSkill(s)}>
                {SKILL_TEXT[s]}
              </button>
            ))}
          </div>
          <input
            class="span2"
            value={contact.note}
            placeholder="Note: role, where to find you"
            aria-label="Contact note"
            onInput={(e) => setContact((c) => ({ ...c, note: fitInput(e, Math.max(0, noteMax)) }))}
          />
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
            <span class="muted small">Up to {bytes(MAX_FILE_BYTES)}. Resonance shrinks photos to fit.</span>
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
        {!toEveryone && neighbors.length === 0 && <span class="muted small">People appear here once their phone is heard.</span>}
        <span class="budget small">
          {(mode === 'text' || mode === 'contact') && <span class={room < 0 ? 'over' : ''}>{room} bytes left · </span>}
          {eta > 0 && (mode === 'file' ? <>about {seconds(eta)} to send</> : <>about {seconds(eta)} on air</>)}
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
      {mode === 'text' && room < 0 && (
        <p class="error small">
          <span role="alert">Too long for one sound packet.</span> Trim {-room} bytes.
        </p>
      )}
      {error && (
        <p class="error small" role="alert">
          {error}
        </p>
      )}
      <p class="sr-only" aria-live="polite">
        {said}
      </p>
    </form>
  );
}
