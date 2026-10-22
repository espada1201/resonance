import type { Need, Status } from './mesh/payloads';
import { type CheckInBody, type Heard, type ReplyBody, rosterKey, sentAt } from './roster';

// Courier to the outside world. A check-in can name a phone number or an email address. Every
// device that carries it lists it, and whichever one gets a signal (a hilltop, a neighbour's
// satellite texting) passes it on through its own text or mail app; a "passed on" reply then
// floods back so nobody sends it twice. No server is involved: the family gets an ordinary text.

export interface Address {
  channel: 'sms' | 'email';
  to: string;
}

export interface Parcel {
  checkin: Heard<CheckInBody>;
  address: Address;
  /** The reply saying someone passed it on, once anyone has. */
  passed?: Heard<ReplyBody>;
}

/**
 * A phone number or an email address as typed, or null. Addresses arrive over the air from
 * strangers, so only plain ones pass: nothing that could add recipients or a script to a link.
 */
export function parseOutside(typed: string): Address | null {
  const s = typed.trim();
  if (/^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(s)) return { channel: 'email', to: s };
  const phone = s.replace(/[\s().-]/g, '');
  return /^\+?\d{5,20}$/.test(phone) ? { channel: 'sms', to: phone } : null;
}

const ref = (src: number, msgId: number) => `${src}:${msgId}`;

/**
 * The latest check-in for each person and address, newest first. Older ones to the same address
 * are left out: the family needs the latest news, once.
 */
export function parcels(checkins: Heard<CheckInBody>[], replies: Heard<ReplyBody>[]): Parcel[] {
  const passed = new Map<string, Heard<ReplyBody>>();
  for (const r of replies) if (r.body.what === 'passed') passed.set(ref(r.body.src, r.body.msgId), r);
  const latest = new Map<string, Parcel>();
  for (const c of checkins) {
    const address = c.body.outside ? parseOutside(c.body.outside) : null;
    if (!address) continue;
    const k = `${rosterKey(c)} ${address.to}`;
    const prev = latest.get(k);
    if (!prev || sentAt(c) > sentAt(prev.checkin)) latest.set(k, { checkin: c, address, passed: passed.get(ref(c.src, c.msgId)) });
  }
  return [...latest.values()].sort((a, b) => sentAt(b.checkin) - sentAt(a.checkin));
}

const SAYS: Record<Status, string> = { safe: 'is safe', help: 'needs help', medical: 'needs medical help', sheltering: 'is sheltering' };

/** The message the family receives, in plain words: who, how they are, where, and how it reached them. */
export function courierText(c: CheckInBody, from: string, when: string, needText: Record<Need, string>): string {
  const who = c.about ? `${c.about} (reported by ${from})` : from;
  const needs = c.needs?.length ? ` (${c.needs.map((n) => needText[n].toLowerCase()).join(', ')})` : '';
  return [
    `${who} ${SAYS[c.status]}${needs}.`,
    c.place && `Place: ${c.place}.`,
    c.note && `"${c.note}"`,
    c.geo && `Map: https://www.google.com/maps?q=${c.geo.lat.toFixed(5)},${c.geo.lon.toFixed(5)}`,
    `Sent ${when} over Resonance, an offline network made of sound; a stranger's phone with signal passed it on, so replies will not reach them.`,
  ]
    .filter(Boolean)
    .join(' ');
}

/** Opens the phone's own text or mail app with everything filled in; the person sending still taps Send. */
export function courierLink(a: Address, subject: string, text: string): string {
  // "?&body=" is read by both iOS (after the &) and Android (after the ?).
  return a.channel === 'sms'
    ? `sms:${a.to}?&body=${encodeURIComponent(text)}`
    : `mailto:${a.to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
}
