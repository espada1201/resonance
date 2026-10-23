import { type Need, type ReplyKind, type Skill, type Status, type Topic, fitUtf8 } from '../mesh/payloads';
import type { ProfileId } from '../modem/profiles';
import type { Strength } from '../signal';

/** Keeps a text input within `max` UTF-8 bytes (an emoji is 4), the room its field has on air. */
export function fitInput(e: Event, max: number): string {
  const el = e.target as HTMLInputElement;
  const v = fitUtf8(el.value, max);
  if (v !== el.value) el.value = v;
  return v;
}

/** The parts that are there, apart from `sep`: empty, false and missing parts are left out. */
export const joinParts = (sep: string, ...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(sep);

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** How far a message travelled to get here: each phone that repeated it is one more time. */
export const passedOnText = (hops: number) => `passed along ${hops} ${hops === 1 ? 'time' : 'times'}`;

/** What a message says about where it came from when it was heard from the sender's own phone. */
export const HEARD_FROM_SENDER = 'heard from their own phone';
/** Our own broadcast or reply, said by the same words on the Feed and on Safety: whether another phone repeated it. */
export const HEARD_BY_NEARBY = 'heard by a phone nearby';
export const NOT_HEARD_YET = 'not heard by another phone yet';
/** Until the first resend has had its turn, no news is no failure: sound is slow. */
export const SENDING_TEXT = 'sending… this can take up to a minute';
/** Our reply, once the phone that asked has said it has it. */
export const askerHasIt = (name: string) => `${name}'s phone has it`;

export const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function seconds(s: number): string {
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s - m * 60)} s`;
}

export const bytes = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

export const STATUS_TEXT: Record<Status, string> = {
  safe: 'Safe',
  help: 'Needs help',
  medical: 'Needs medical help',
  sheltering: 'Sheltering',
};

export const NEED_TEXT: Record<Need, string> = {
  trapped: 'Trapped',
  injured: 'Injured',
  medicine: 'Medicine',
  water: 'Water',
  food: 'Food',
  power: 'Power',
  transport: 'Transport',
  shelter: 'Shelter',
};

export const SKILL_TEXT: Record<Skill, string> = {
  firstaid: 'First aid',
  medical: 'Doctor or nurse',
  power: 'Power to share',
  water: 'Drinking water',
  vehicle: 'Vehicle',
  satphone: 'Satellite texting',
  language: 'Interpreter',
  space: 'Room for people',
};

export const TOPIC_TEXT: Record<Topic, string> = {
  water: 'Water',
  food: 'Food',
  power: 'Charging',
  medical: 'Medical',
  shelter: 'Shelter',
  danger: 'Danger',
  info: 'Info',
};

/** "Ben is on the way", "Ben marked it resolved", "Ben passed it on". */
export const REPLY_TEXT: Record<ReplyKind, string> = { coming: 'is on the way', resolved: 'marked it resolved', passed: 'passed it on' };

/** A request its sender took back: what everyone sees instead of a call for help. The protocol still says "resolved". */
export const CANCELLED_TEXT = 'Cancelled: sent by mistake';
/** An older check-in on the Feed, once the same person has sent a newer one: it is not a second request. */
export const REPLACED_TEXT = 'Earlier check-in, replaced by a newer one';
export const TOOK_BACK_TEXT = 'took it back: sent by mistake';

export const STRENGTH_TEXT: Record<Strength, string> = { strong: 'Strong signal', fair: 'Fair signal', weak: 'Weak signal' };

export const PROFILE_NAME: Record<ProfileId, string> = { audible: 'Audible', fast: 'Fast', ultrasonic: 'Quiet' };
