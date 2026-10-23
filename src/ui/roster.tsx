import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { offset } from '../geo';
import { type Geo, type ReplyKind, SKILLS, type Skill } from '../mesh/payloads';
import { type Heard, type ReplyBody, type RosterEntry, needingYou, tookBack, writtenAt } from '../roster';
import type { Station } from '../station';
import { CANCELLED_TEXT, HEARD_BY_NEARBY, HEARD_FROM_SENDER, NEED_TEXT, NOT_HEARD_YET, REPLY_TEXT, SKILL_TEXT, STATUS_TEXT, TOOK_BACK_TEXT, ago, joinParts, passedOnText } from './format';
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
  return e.resolved && !e.cancelled ? 'Resolved' : '';
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
  /** One reply as a line: who, how long ago, and for our own what is known about whether it was heard. */
  replyLine: (r: Heard<ReplyBody>) => string;
  /** A Find action for someone whose own device is in earshot, or null. */
  find: (e: RosterEntry) => (() => void) | null;
  readout?: (e: RosterEntry) => ComponentChildren;
  /** This device's own name, so its row reads "You (Margaret)". */
  nick?: string;
}

export const replyText = (r: Heard<ReplyBody>, self: number, by: (src: number, nick: string) => string) => {
  const did = tookBack(r) ? TOOK_BACK_TEXT : REPLY_TEXT[r.body.what];
  return r.src === self ? `You ${r.body.what === 'coming' ? 'are on the way' : did}` : `${by(r.src, r.body.nick)} ${did}`;
};

/** What is known about whether our own reply, such as "On my way", was heard: empty for anyone else's. */
export function replyReceipt(station: Station, r: Heard<ReplyBody>): string {
  if (r.src !== station.id) return '';
  if (station.queued(r)) return 'waiting to send…';
  return station.journal.wasPassedOn(r.msgId) ? HEARD_BY_NEARBY : `sent, ${NOT_HEARD_YET}`;
}

/** "Ben is on the way · 2 min ago", or for our own "You are on the way · just now · heard by a phone nearby". */
export const replyLine = (station: Station, r: Heard<ReplyBody>, by: (src: number, nick: string) => string) =>
  joinParts(' · ', replyText(r, station.id, by), ago(writtenAt(r)), replyReceipt(station, r));

/**
 * "3 people · 3 asking for help · 1 waiting for you · you are on your way to 1": what is true, in the words a
 * stranger would use. It never says "none for you" while someone is still waiting, which read as "nobody needs you".
 * The tab's count is the "waiting for you" part: other people's open requests this device has not answered.
 */
export function headcount(entries: RosterEntry[], self?: number) {
  const open = entries.filter((e) => e.open);
  const people = `${entries.length} ${entries.length === 1 ? 'person' : 'people'}`;
  if (!open.length) return `${people} · no one is asking for help`;
  const asking = `${open.length} asking for help`;
  if (self === undefined) return `${people} · ${asking}`;
  const forYou = needingYou(entries, self).length;
  const onWay = open.filter((e) => e.replies.some((r) => r.src === self && r.body.what === 'coming')).length;
  const own = open.find((e) => e.latest.src === self && !e.latest.body.about);
  return joinParts(
    ' · ',
    people,
    asking,
    forYou > 0 && `${forYou} waiting for you`,
    onWay > 0 && `you are on your way to ${onWay}`,
    own && (own.coming ? 'someone is coming to you' : 'you are waiting for someone'),
  );
}

/** Everyone's latest check-in, in the order a responder works through them. */
export function RosterList({ entries, me, self, name, by, reply, replyLine, find, readout, nick }: RosterProps) {
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
        const where = joinParts(' · ', b.place, relative(me, b.geo));
        return (
          <li key={e.key} class={e.cancelled ? 'cancelled' : `s-${b.status}${e.open ? ' open' : ''}`}>
            <p class="status-line">
              <span class="status-word">{e.cancelled ? CANCELLED_TEXT : STATUS_TEXT[b.status]}</span>
              <span class="who">{mine ? 'You' : name(e)}</span>
              {mine && nick && ' '}
              {mine && nick && <span class="who-nick">({nick})</span>}
              {state(e) && <span class="chip">{state(e)}</span>}
            </p>
            {b.needs && !e.cancelled && (
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
              {joinParts(' · ', where, b.about && `reported by ${by(src, b.nick)}`, `sent ${ago(writtenAt(e.latest))}`, src !== self && (hops ? passedOnText(hops) : HEARD_FROM_SENDER))}
            </p>
            {e.replies.map((r) => (
              <p key={`${r.src}:${r.msgId}`} class="small reply">
                {replyLine(r)}
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
