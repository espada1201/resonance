import { describe, expect, it } from 'vitest';
import type { Need, ReplyKind, Status } from './mesh/payloads';
import { type CheckInBody, type Heard, type ReplyBody, type RosterEntry, roster, rosterCsv, search } from './roster';

const T = 1_700_000_000;
let ids = 0;

function checkIn(src: number, status: Status, sentSec: number, extra: Partial<CheckInBody> = {}, heardMs = sentSec * 1000): Heard<CheckInBody> {
  return { src, msgId: ++ids, at: heardMs, hops: 1, body: { kind: 'checkin', ts: sentSec, nick: `n${src}`, status, note: '', ...extra } };
}
function reply(to: Heard<CheckInBody>, what: ReplyKind, sentSec: number, by = 9): Heard<ReplyBody> {
  return { src: by, msgId: ++ids, at: sentSec * 1000, hops: 0, body: { kind: 'reply', ts: sentSec, nick: `n${by}`, what, src: to.src, msgId: to.msgId } };
}
const names = (es: RosterEntry[]) => es.map((e) => e.latest.body.about ?? e.latest.body.nick);

describe('safety roster', () => {
  it('an old "I need help" carried in late does not hide a newer "I\'m safe"', () => {
    // Ana's 10:30 "safe" was heard at 10:30, her 10:00 "help" only at 11:00.
    const help = checkIn(5, 'help', T, {}, (T + 3600) * 1000);
    const safe = checkIn(5, 'safe', T + 1800);
    const [ana] = roster([safe, help], [], T + 3600);
    expect(ana.latest.body.status).toBe('safe');
    expect(ana.open).toBe(false);
  });

  it('gives someone without a phone their own entry, however their name is typed', () => {
    const r = roster(
      [checkIn(5, 'safe', T), checkIn(6, 'help', T + 60, { about: 'María  López' }), checkIn(7, 'safe', T + 120, { about: 'maria lopez' })],
      [],
      T + 200,
    );
    expect(r).toHaveLength(2);
    const maria = r.find((e) => e.key === 'name:maria lopez')!;
    expect(maria.latest.src).toBe(7);
    expect(maria.latest.body.status).toBe('safe');
  });

  it('puts requests nobody is coming to first, longest waiting first, then the rest', () => {
    const now = T + 3 * 86400;
    const waitingLong = checkIn(1, 'help', now - 3000);
    const waitingShort = checkIn(2, 'medical', now - 600);
    const helped = checkIn(3, 'help', now - 5000);
    const stale = checkIn(4, 'help', now - 2 * 86400);
    const shelter = checkIn(5, 'sheltering', now - 100);
    const resolved = checkIn(6, 'medical', now - 7000);
    const safeOld = checkIn(7, 'safe', now - 9000);
    const safeNew = checkIn(8, 'safe', now - 50);
    const r = roster(
      [safeOld, stale, waitingShort, resolved, safeNew, helped, shelter, waitingLong],
      [reply(helped, 'coming', now - 4000), reply(resolved, 'resolved', now - 6000)],
      now,
    );
    expect(names(r)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n8', 'n7']);
    expect(r.map((e) => [e.open, e.stale, e.coming, e.resolved])).toEqual([
      [true, false, false, false],
      [true, false, false, false],
      [true, false, true, false],
      [false, true, false, false],
      [false, false, false, false],
      [false, false, false, true],
      [false, false, false, false],
      [false, false, false, false],
    ]);
  });

  it('keeps "On my way" when the person sends an update, and starts afresh after they were safe', () => {
    const first = checkIn(1, 'help', T);
    const update = checkIn(1, 'help', T + 600, { note: 'still stuck' });
    const coming = reply(first, 'coming', T + 300);
    let [e] = roster([first, update], [coming], T + 700);
    expect(e.latest).toBe(update);
    expect(e.coming).toBe(true);
    expect(e.replies).toEqual([coming]);

    const safe = checkIn(1, 'safe', T + 900);
    const again = checkIn(1, 'medical', T + 5000);
    [e] = roster([first, update, safe, again], [coming], T + 5100);
    expect(e.open).toBe(true);
    expect(e.coming).toBe(false);
    expect(e.replies).toEqual([]);
  });

  it('finds people by name, place, note or need, ignoring case and accents', () => {
    const r = roster(
      [checkIn(1, 'help', T, { needs: ['medicine', 'water'], place: 'Floor 4' }), checkIn(2, 'safe', T, { about: 'José Núñez', note: 'with his dog' })],
      [],
      T,
    );
    const name = (e: RosterEntry) => e.latest.body.about ?? e.latest.body.nick;
    const needText = { medicine: 'Medicine', water: 'Water' } as Record<Need, string>;
    expect(names(search(r, 'nunez', name, needText))).toEqual(['José Núñez']);
    expect(names(search(r, 'FLOOR', name, needText))).toEqual(['n1']);
    expect(names(search(r, 'water', name, needText))).toEqual(['n1']);
    expect(names(search(r, ' dog ', name, needText))).toEqual(['José Núñez']);
    expect(search(r, '', name, needText)).toHaveLength(2);
  });

  it('exports a spreadsheet that quotes text and never runs a formula', () => {
    const help = checkIn(1, 'help', T, { needs: ['trapped'], place: 'Room 4, "north"', note: '=HYPERLINK("http://x")', geo: { lat: 35.59512, lon: -82.55151, accuracyM: 12.4 }, outside: '+1 555 0100' });
    const csv = rosterCsv(roster([help, checkIn(2, 'safe', T, { about: 'Maria' })], [reply(help, 'coming', T + 60)], T + 100), {
      name: (e) => e.latest.body.about ?? e.latest.body.nick,
      by: (src, nick) => nick || `#${src}`,
      status: { safe: 'Safe', help: 'Needs help', medical: 'Medical', sheltering: 'Sheltering' },
      need: { trapped: 'Trapped' } as Record<Need, string>,
    });
    const [head, ana, maria] = csv.trimEnd().split('\r\n');
    expect(head).toBe('Name,Reported by,Status,Request,Needs,Place,Note,Latitude,Longitude,Accuracy (m),Sent (UTC),Hops,Replies,Outside contact');
    expect(ana).toBe(
      `n1,,Needs help,open,Trapped,"Room 4, ""north""","'=HYPERLINK(""http://x"")",35.59512,-82.55151,12,2023-11-14T22:13:20.000Z,1,n9 on the way 2023-11-14T22:14:20.000Z,'+1 555 0100`,
    );
    expect(maria).toBe('Maria,n2,Safe,,,,,,,,2023-11-14T22:13:20.000Z,1,,');
  });
});
