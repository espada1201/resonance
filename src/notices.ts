import type { Body } from './mesh/payloads';
import { type Heard, fold } from './roster';

// Notices: "Water at the school gym until 6 pm", "Bridge on Elm St is out". A pinned board for
// what everyone nearby needs to know, each one shown until the time its author gave runs out.

export type NoticeBody = Extract<Body, { kind: 'notice' }>;

/** The notices still running, danger first, then newest; an author's update replaces their earlier notice about the same topic and place. */
export function activeNotices(notices: Heard<NoticeBody>[], nowSec: number): Heard<NoticeBody>[] {
  const latest = new Map<string, Heard<NoticeBody>>();
  for (const n of notices) {
    const k = `${n.src} ${n.body.topic} ${fold(n.body.place)}`;
    const prev = latest.get(k);
    if (!prev || n.body.ts > prev.body.ts) latest.set(k, n);
  }
  return [...latest.values()]
    .filter((n) => n.body.ts + n.body.hours * 3600 > nowSec)
    .sort((a, b) => Number(b.body.topic === 'danger') - Number(a.body.topic === 'danger') || b.body.ts - a.body.ts);
}
