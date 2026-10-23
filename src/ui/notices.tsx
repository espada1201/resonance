import { MAX_PLACE, TOPICS, type Topic } from '../mesh/payloads';
import type { Heard, NoticeBody } from '../roster';
import { TOPIC_TEXT, clock, fitInput, joinParts } from './format';
import { rovingKeys } from './hooks';

/** How long a notice stays up, in hours. */
export const NOTICE_HOURS: Array<[number, string]> = [
  [3, '3 hours'],
  [12, '12 hours'],
  [24, '1 day'],
  [72, '3 days'],
];

export interface NoticeDraft {
  topic: Topic;
  place: string;
  hours: number;
  text: string;
}

export const newNotice = (): NoticeDraft => ({ topic: 'info', place: '', hours: 12, text: '' });

/** "until 18:00", or with the day when it is not today. */
function until(sec: number) {
  const end = new Date(sec * 1000);
  const today = end.toDateString() === new Date().toDateString();
  return `until ${today ? clock(end.getTime()) : end.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`;
}

/** The notices still running, danger first. `large` is for the beacon's screen across a room. */
export function NoticeBoard({ notices, by, large = false }: { notices: Heard<NoticeBody>[]; by: (src: number, nick: string) => string; large?: boolean }) {
  if (!notices.length) return null;
  return (
    <section class={large ? 'notices huge' : 'notices'} aria-label="Notices">
      {notices.map((n) => (
        <article key={`${n.src}:${n.msgId}`} class={`notice t-${n.body.topic}`}>
          <span class="topic">{TOPIC_TEXT[n.body.topic]}</span>
          <p class="notice-text">{n.body.text}</p>
          <p class="muted small">{joinParts(' · ', n.body.place, until(n.body.ts + n.body.hours * 3600), `from ${by(n.src, n.body.nick)}`)}</p>
        </article>
      ))}
    </section>
  );
}

/** The fields of a notice; `room` is how many bytes the packet has left for the text. */
export function NoticeFields({ draft, set, room }: { draft: NoticeDraft; set: (patch: Partial<NoticeDraft>) => void; room: number }) {
  const textMax = room + new TextEncoder().encode(draft.text).length;
  return (
    <div class="checkin-fields">
      <div class="pills" role="radiogroup" aria-label="Topic" onKeyDown={rovingKeys(TOPICS, draft.topic, (topic) => set({ topic }))}>
        {TOPICS.map((t) => (
          <button key={t} type="button" role="radio" aria-checked={draft.topic === t} tabIndex={draft.topic === t ? 0 : -1} class={`pill t-${t}`} onClick={() => set({ topic: t })}>
            {TOPIC_TEXT[t]}
          </button>
        ))}
      </div>
      <label class="field-with-count">
        <textarea
          rows={2}
          value={draft.text}
          placeholder="What everyone nearby should know: water at the gym until 6 pm, the bridge is out…"
          aria-label="Notice"
          onInput={(e) => set({ text: fitInput(e, Math.max(0, textMax)) })}
        />
        <span class={room < 0 ? 'count over' : 'count'} aria-live="polite">
          {room} bytes left
        </span>
      </label>
      <div class="grid2">
        <input value={draft.place} placeholder="Where (optional)" aria-label="Where" onInput={(e) => set({ place: fitInput(e, MAX_PLACE) })} />
        <select value={String(draft.hours)} aria-label="Show it for" onChange={(e) => set({ hours: Number((e.target as HTMLSelectElement).value) })}>
          {NOTICE_HOURS.map(([h, label]) => (
            <option key={h} value={String(h)}>
              Show for {label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
