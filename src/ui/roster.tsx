import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { offset } from '../geo';
import { type Geo, type ReplyKind, SKILLS, type Skill } from '../mesh/payloads';
import { type Heard, type ReplyBody, type RosterEntry, writtenAt } from '../roster';
import { NEED_TEXT, REPLY_TEXT, SKILL_TEXT, STATUS_TEXT, ago } from './format';
import { handFocusOn } from './hooks';
import { Compass } from './icons';

/** Where someone is from here, in words, if both positions are known. */
export function relative(me: Geo | null, there: Geo | undefined): string {
  if (!there) return '';
  if (!me) return 'position attached';
  return offset(me, there) ?? 'right next to you';
}

function state(e: RosterEntry): string {
  if (e.open) return e.coming ? 'Help on the way' : 'Waiting for help';
  if (e.stale) return 'No news for a day';
  return e.resolved ? 'Resolved' : '';
}

interface RosterProps {
  entries: RosterEntry[];
  me: Geo | null;
  /** This device, so its own requests offer only "Resolved". */
  self: number;
  name: (e: RosterEntry) => string;
  by: (src: number, nick: string) => string;
  /** Null while replies cannot be sent (not listening). */
  reply: ((e: RosterEntry, what: ReplyKind) => void) | null;
  /** A Find action for someone whose own device is in earshot, or null. */
  find: (e: RosterEntry) => (() => void) | null;
  readout?: (e: RosterEntry) => ComponentChildren;
}

export const replyText = (r: Heard<ReplyBody>, self: number, by: (src: number, nick: string) => string) =>
  r.src === self ? `You ${r.body.what === 'coming' ? 'are on the way' : REPLY_TEXT[r.body.what]}` : `${by(r.src, r.body.nick)} ${REPLY_TEXT[r.body.what]}`;

/** "3 people · 1 open request" */
export function headcount(entries: RosterEntry[]) {
  const open = entries.filter((e) => e.open).length;
  return `${entries.length} ${entries.length === 1 ? 'person' : 'people'} · ${open} open ${open === 1 ? 'request' : 'requests'}`;
}

/** Everyone's latest check-in, in the order a responder works through them. */
export function RosterList({ entries, me, self, name, by, reply, find, readout }: RosterProps) {
  // Resolved closes a request on every phone, and it sits beside On my way: it asks once more.
  // Keyed by the ask, so a new one from the same person never opens with the question showing.
  const [closing, setClosing] = useState<string | null>(null);
  const notYet = useRef<HTMLButtonElement>(null);
  useEffect(() => notYet.current?.focus(), [closing]);
  return (
    <ul class="people roster">
      {entries.map((e) => {
        const { body: b, src, msgId, hops } = e.latest;
        const mine = src === self && !b.about;
        const findIt = e.open || e.stale ? find(e) : null;
        const confirming = reply && closing === `${src}:${msgId}`;
        const where = [b.place, relative(me, b.geo)].filter(Boolean).join(' · ');
        return (
          <li key={e.key} class={`s-${b.status}${e.open ? ' open' : ''}`}>
            <p class="status-line">
              <span class="status-word">{STATUS_TEXT[b.status]}</span>
              <span class="who">{mine ? 'You' : name(e)}</span>
              {state(e) && <span class="chip">{state(e)}</span>}
            </p>
            {b.needs && (
              <p class="pills" aria-label="Needs">
                {b.needs.map((n) => (
                  <span key={n} class="chip need">
                    {NEED_TEXT[n]}
                  </span>
                ))}
              </p>
            )}
            {b.note && <p class="text-body">{b.note}</p>}
            <p class="muted small">
              {[where, b.about && `reported by ${by(src, b.nick)}`, `sent ${ago(writtenAt(e.latest))}`, src !== self && (hops ? `${hops} hop${hops > 1 ? 's' : ''}` : 'heard directly')]
                .filter(Boolean)
                .join(' · ')}
            </p>
            {e.replies.map((r) => (
              <p key={`${r.src}:${r.msgId}`} class="small reply">
                {replyText(r, self, by)} · {ago(writtenAt(r))}
              </p>
            ))}
            {(e.open || e.stale) && confirming && (
              <div class="actions" role="group" aria-label="Resolved for everyone?">
                <span class="small">Resolved for everyone?</span>
                <button type="button" class="ghost small" ref={notYet} onClick={() => setClosing(null)}>
                  Not yet
                </button>
                <button
                  type="button"
                  class="ghost small"
                  onClick={() => {
                    setClosing(null);
                    reply(e, 'resolved');
                  }}
                >
                  Yes, resolved
                </button>
              </div>
            )}
            {(e.open || e.stale) && !confirming && (
              <div class="actions">
                {reply && !mine && !e.replies.some((r) => r.src === self && r.body.what === 'coming') && (
                  <button
                    type="button"
                    class="ghost small"
                    onClick={(ev) => {
                      handFocusOn(ev.currentTarget);
                      reply(e, 'coming');
                    }}
                  >
                    On my way
                  </button>
                )}
                {reply && (
                  <button type="button" class="ghost small" onClick={() => (mine ? reply(e, 'resolved') : setClosing(`${src}:${msgId}`))}>
                    {mine ? 'I got help' : 'Resolved'}
                  </button>
                )}
                {findIt && (
                  <button type="button" class="ghost small" onClick={findIt} aria-label={`Find ${name(e)}: measure the distance by sound`}>
                    <Compass size={14} /> Find
                  </button>
                )}
              </div>
            )}
            {readout?.(e)}
          </li>
        );
      })}
    </ul>
  );
}

export interface Helper {
  key: string;
  name: string;
  phone: string;
  note: string;
  skills: Skill[];
  at: number;
}

/** Contact cards that offer help, grouped by what they offer. */
export function HelperList({ helpers }: { helpers: Helper[] }) {
  const offered = SKILLS.filter((s) => helpers.some((h) => h.skills.includes(s)));
  return (
    <dl class="helpers">
      {offered.map((s) => (
        <div key={s}>
          <dt>{SKILL_TEXT[s]}</dt>
          {helpers
            .filter((h) => h.skills.includes(s))
            .map((h) => (
              <dd key={h.key}>
                <strong>{h.name}</strong>
                {h.phone && (
                  <>
                    {' · '}
                    <a href={`tel:${h.phone.replace(/[^+\d]/g, '')}`}>{h.phone}</a>
                  </>
                )}
                <span class="muted small">
                  {h.note && ` · ${h.note}`} · {ago(h.at)}
                </span>
              </dd>
            ))}
        </div>
      ))}
    </dl>
  );
}
