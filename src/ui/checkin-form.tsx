import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { parseOutside } from '../courier';
import { locateWithin } from '../geo';
import { nodeHex } from '../mesh/packet';
import { type Geo, MAX_CONTACT_NAME, MAX_NICK, MAX_OUTSIDE, MAX_PLACE, NEEDS, type Need, STATUSES, type Status } from '../mesh/payloads';
import type { CheckInBody } from '../roster';
import type { Station } from '../station';
import { NEED_TEXT, STATUS_TEXT, fitInput } from './format';
import { rovingKeys } from './hooks';
import { Pin } from './icons';

export interface CheckInDraft {
  status: Status;
  needs: Need[];
  place: string;
  note: string;
  /** Checking in for someone without a phone: whom. */
  forSomeone: boolean;
  about: string;
  /** A phone number or email address outside, for whoever gets signal to pass it on to. */
  outside: string;
  withGeo: boolean;
}

export const asking = (s: Status) => s === 'help' || s === 'medical';

/** Stands in for a GPS fix when measuring how much room a check-in leaves: every fix is the same size. */
export const ANY_FIX: Geo = { lat: 0, lon: 0, accuracyM: 0 };

/** A fresh draft that remembers where you are and whom to tell outside. */
export const newDraft = (remembered: { place: string; outside: string }, status: Status = 'safe'): CheckInDraft => ({
  status,
  needs: [],
  place: remembered.place,
  note: '',
  forSomeone: false,
  about: '',
  outside: remembered.outside,
  withGeo: false,
});

/** The fields of a check-in as sent: empty ones left out, needs only with a request for help. */
export function draftFields(d: CheckInDraft, geo?: Geo): Omit<CheckInBody, 'kind' | 'ts' | 'nick'> {
  return {
    status: d.status,
    note: d.note.trim(),
    geo,
    needs: asking(d.status) && d.needs.length ? NEEDS.filter((n) => d.needs.includes(n)) : undefined,
    place: d.place.trim() || undefined,
    about: (d.forSomeone && d.about.trim()) || undefined,
    outside: d.outside.trim() || undefined,
  };
}

/** A check-in goes out with or without a position; no position is said calmly, once, and is nothing to fix. */
export const NO_FIX_NOTE = 'Location not found yet — add where you are in words if you can.';

/** The position to send, or undefined if there is none yet: the check-in goes either way. */
export async function checkInFix(station: Station): Promise<Geo | undefined> {
  try {
    const geo = await locateWithin(3000);
    station.setPosition(geo);
    return geo;
  } catch {
    return undefined;
  }
}

/** Why a draft cannot go yet, or null. */
export function draftProblem(d: CheckInDraft): string | null {
  if (d.forSomeone && !d.about.trim()) return 'Who is this check-in for? Type their name.';
  if (d.outside.trim() && !parseOutside(d.outside)) return 'For family outside, type a phone number or an email address.';
  return null;
}

/** The line added after a check-in went out under no name: empty with a name, or for someone else (`about`), who is named in it. */
export const nameless = (station: Station, about: string | undefined) =>
  station.settings.nick || about ? '' : `Others see you as #${nodeHex(station.id)}. Type your name in the box above, then send again.`;

/** A call for help sent from here can be taken back for this long, as long as nobody has closed it. */
export const TAKE_BACK_MS = 10 * 60_000;

/** Whether the request sent at `sent.at` (ms) can still be taken back at `now`. */
export const takeBackOffered = (sent: { at: number } | null, now: number) => !!sent && now - sent.at < TAKE_BACK_MS;

/**
 * Asks for the name beside the check-in buttons. `offered`: the page opened with no name, so the box stays
 * for the whole visit, with whatever was typed in it, wherever the buttons are. `prompt`: a check-in just went out without a name.
 */
export function NameField({ station, prompt, offered }: { station: Station; prompt?: boolean; offered: boolean }) {
  if (!offered && station.settings.nick) return null;
  return (
    <div class={prompt && !station.settings.nick ? 'name-field prompt' : 'name-field'}>
      <input
        value={station.settings.nick}
        placeholder="Your name"
        aria-label="Your name"
        onInput={(e) => station.update({ nick: fitInput(e, MAX_NICK) })}
      />
      {!station.settings.nick && <p class="muted small">Without a name, others see you as #{nodeHex(station.id)}.</p>}
    </div>
  );
}

/**
 * The fields of a check-in, shared by the Safety tab and the composer. `room` is how many bytes
 * the packet has left, so the note can never outgrow it.
 */
export function CheckInFields({ draft, set, room, beforeWhere }: { draft: CheckInDraft; set: (patch: Partial<CheckInDraft>) => void; room: number; beforeWhere?: ComponentChildren }) {
  const noteMax = room + new TextEncoder().encode(draft.note).length;
  const toggle = (n: Need) => set({ needs: draft.needs.includes(n) ? draft.needs.filter((x) => x !== n) : [...draft.needs, n] });
  const badOutside = draft.outside.trim() !== '' && !parseOutside(draft.outside);
  // Folded away unless something in them is already set, such as a family contact remembered from last time.
  const [needAt, setNeedAt] = useState<Need>(NEEDS[0]);
  const [extrasAtOpen] = useState(draft.forSomeone || draft.outside.trim() !== '' || draft.withGeo);
  return (
    <div class="checkin-fields">
      <div class="pills" role="radiogroup" aria-label="Status" onKeyDown={rovingKeys(STATUSES, draft.status, (status) => set({ status }))}>
        {STATUSES.map((s) => (
          <button key={s} type="button" role="radio" aria-checked={draft.status === s} tabIndex={draft.status === s ? 0 : -1} class={`pill s-${s}`} onClick={() => set({ status: s })}>
            {STATUS_TEXT[s]}
          </button>
        ))}
      </div>
      {beforeWhere}
      <input value={draft.place} placeholder="Where: floor, room or street (optional)" aria-label="Where" onInput={(e) => set({ place: fitInput(e, MAX_PLACE) })} />
      <label class="field-with-count">
        <input value={draft.note} placeholder="Short note (optional)" aria-label="Note" onInput={(e) => set({ note: fitInput(e, Math.max(0, noteMax)) })} />
        <span class={room < 0 ? 'count over' : 'count'} aria-live="polite">
          {room} bytes left
        </span>
      </label>
      {/* After the boxes, not between them: someone tabbing on to type must not land on a need and switch it on. */}
      {asking(draft.status) && (
        <div class="needs">
          <div class="needs-head" aria-hidden="true">
            <span class="small">What is needed?</span>
            <span class="key-hint">Arrow keys move, Space picks</span>
          </div>
          {/* One Tab stop, so eight needs do not stand between the note and Send. */}
          <div class="pills" role="toolbar" aria-label="What is needed" onKeyDown={rovingKeys(NEEDS, needAt, setNeedAt)}>
            {NEEDS.map((n) => (
              <button
                key={n}
                type="button"
                class="pill need"
                aria-pressed={draft.needs.includes(n)}
                tabIndex={n === needAt ? 0 : -1}
                onFocus={() => setNeedAt(n)}
                onClick={() => toggle(n)}
              >
                {NEED_TEXT[n]}
              </button>
            ))}
          </div>
        </div>
      )}
      <details class="more" open={extrasAtOpen}>
        <summary>Someone without a phone, family outside, GPS</summary>
        <div class="extras">
          <label class="toggle">
            <input type="checkbox" checked={draft.forSomeone} onChange={(e) => set({ forSomeone: (e.target as HTMLInputElement).checked })} />
            For someone without a phone
          </label>
          {draft.forSomeone && (
            <input value={draft.about} placeholder="Their name" aria-label="Their name" onInput={(e) => set({ about: fitInput(e, MAX_CONTACT_NAME) })} />
          )}
          <input
            value={draft.outside}
            placeholder="Family outside: phone or email (optional)"
            aria-label="Family outside: phone or email"
            aria-invalid={badOutside}
            inputMode="email"
            onInput={(e) => set({ outside: fitInput(e, MAX_OUTSIDE) })}
          />
          <p class="muted small">
            Whoever gets signal first can text or email it to them. Everyone who carries it can read it, unless your circle seals it.
          </p>
          <label class="toggle">
            <input type="checkbox" checked={draft.withGeo} onChange={(e) => set({ withGeo: (e.target as HTMLInputElement).checked })} />
            <Pin size={14} /> Attach my GPS position
          </label>
        </div>
      </details>
    </div>
  );
}
