import { useEffect, useState } from 'preact/hooks';
import { bearingDeg, distanceM, locate } from '../geo';
import type { Geo, ReplyKind, Status } from '../mesh/payloads';
import { type RosterEntry, rosterCsv, search } from '../roster';
import type { Station } from '../station';
import { ANY_FIX, CheckInFields, type CheckInDraft, draftFields, draftProblem, newDraft } from './checkin-form';
import { CourierList } from './courier';
import { download, named, who } from './feed';
import { FindPanel } from './find';
import { NEED_TEXT, STATUS_TEXT } from './format';
import { Compass, Download, Pin } from './icons';
import { type Helper, HelperList, RosterList } from './roster';

const NICE = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 20_000, 50_000];
const ringLabel = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${+(m / 1000).toFixed(1)} km`);
/** Find needs the person's own device in earshot: heard directly this recently. */
const FINDABLE_MS = 10 * 60_000;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

type OrientationCtor = typeof DeviceOrientationEvent & { requestPermission?: () => Promise<'granted' | 'denied'> };

function useHeading(): [number | null, () => void] {
  const [heading, setHeading] = useState<number | null>(null);
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!on) return;
    const handler = (e: DeviceOrientationEvent & { webkitCompassHeading?: number }) => {
      if (typeof e.webkitCompassHeading === 'number') setHeading(e.webkitCompassHeading);
      else if (e.absolute && e.alpha !== null) setHeading((360 - e.alpha) % 360);
    };
    const name = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
    window.addEventListener(name, handler as EventListener);
    return () => window.removeEventListener(name, handler as EventListener);
  }, [on]);
  const enable = async () => {
    const Ctor = (globalThis as { DeviceOrientationEvent?: OrientationCtor }).DeviceOrientationEvent;
    if (Ctor?.requestPermission && (await Ctor.requestPermission()) !== 'granted') return;
    setOn(true);
  };
  return [heading, enable];
}

function Radar({ me, people, heading, name }: { me: Geo; people: RosterEntry[]; heading: number | null; name: (e: RosterEntry) => string }) {
  const pts = people.flatMap((e) => (e.latest.body.geo ? [{ e, d: distanceM(me, e.latest.body.geo), b: bearingDeg(me, e.latest.body.geo) }] : []));
  const far = Math.max(20, ...pts.map((x) => x.d)) * 1.1;
  const max = NICE.find((n) => n >= far) ?? far;
  const R = 130;
  const rot = heading ?? 0;
  const scale = (d: number) => Math.sqrt(d / max) * R;
  return (
    <svg class="radar" viewBox="-150 -150 300 300" role="img" aria-label={`Map of ${pts.length} check-ins around you`}>
      {[0.25, 0.5, 1].map((f) => (
        <g key={f}>
          <circle r={scale(max * f)} class="ring" />
          <text x={scale(max * f) * 0.71 + 3} y={scale(max * f) * 0.71 + 11} class="ring-label">
            {ringLabel(max * f)}
          </text>
        </g>
      ))}
      <g transform={`rotate(${-rot})`}>
        <text y={-R - 6} class="north" text-anchor="middle">
          N
        </text>
        <line y1={-R} y2={-R + 10} class="tick" />
        {pts.map(({ e, d, b }) => {
          const a = (b * Math.PI) / 180;
          const r = scale(d);
          return (
            <g key={e.key} transform={`translate(${Math.sin(a) * r} ${-Math.cos(a) * r})`} class={`blip s-${e.latest.body.status}`}>
              <circle r={6} />
              <text x={9} y={4} transform={`rotate(${rot})`}>
                {name(e)}
              </text>
            </g>
          );
        })}
      </g>
      <circle r={4} class="me" />
    </svg>
  );
}

/** One tap for "I'm safe" or "I need help"; everything else a check-in can carry, a click away. */
function CheckInCard({ station }: { station: Station }) {
  const [draft, setDraft] = useState<CheckInDraft>(() => newDraft(station.settings));
  const [sending, setSending] = useState<Status | 'detail' | null>(null);
  const [err, setErr] = useState('');
  const listening = station.status === 'listening';
  const set = (patch: Partial<CheckInDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const room = station.budget({ kind: 'checkin', ...draftFields(draft, draft.withGeo ? ANY_FIX : undefined) }).left;

  async function send(d: CheckInDraft, label: Status | 'detail') {
    const problem = draftProblem(d);
    if (problem) return setErr(problem);
    setSending(label);
    setErr('');
    let geo: Geo | undefined;
    if (d.withGeo) {
      try {
        geo = await locate(8000);
        station.setPosition(geo);
      } catch (e) {
        setErr(`${message(e)} Sent without a position.`);
      }
    }
    try {
      // Saying it also remembers where you are and whom to tell outside, for your next check-ins.
      await station.say({ kind: 'checkin', ...draftFields(d, geo) });
      if (label === 'detail') setDraft(newDraft(station.settings));
    } catch (e) {
      setErr(message(e));
    }
    setSending(null);
  }

  const { place, outside } = station.settings;
  return (
    <section class="checkin-card" aria-label="Check in">
      <div class="quick">
        <button type="button" class="big s-safe" disabled={!listening || !!sending} onClick={() => void send({ ...newDraft(station.settings, 'safe'), withGeo: true }, 'safe')}>
          {sending === 'safe' ? 'Sending…' : "I'm safe"}
        </button>
        <button type="button" class="big s-help" disabled={!listening || !!sending} onClick={() => void send({ ...newDraft(station.settings, 'help'), withGeo: true }, 'help')}>
          {sending === 'help' ? 'Sending…' : 'I need help'}
        </button>
      </div>
      <p class="muted small">
        One tap tells everyone in earshot, with your GPS position if you allow it. Other devices pass it on.
        {place && ` It says you are at “${place}”.`}
        {outside && ` Whoever gets signal first can tell ${outside}.`}
      </p>
      <details class="more">
        <summary>More detail: what you need, where, someone without a phone, family outside</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send(draft, 'detail');
          }}
        >
          <CheckInFields draft={draft} set={set} room={room} />
          <button type="submit" class="primary" disabled={!listening || !!sending || room < 0}>
            {sending === 'detail' ? 'Sending…' : 'Send check-in'}
          </button>
        </form>
      </details>
      {err && (
        <p class="error small" role="alert">
          {err}
        </p>
      )}
    </section>
  );
}

/** Contact cards that say what their owner can help with, newest card per person. */
function helpers(station: Station): Helper[] {
  const latest = new Map<string, Helper>();
  for (const i of station.journal.feed) {
    if (i.body?.kind !== 'contact' || !i.body.skills?.length) continue;
    const key = `${i.src}:${i.body.name.toLowerCase()}`;
    if (!latest.has(key)) latest.set(key, { key, name: i.body.name, phone: i.body.phone, note: i.body.note, skills: i.body.skills, at: i.at });
  }
  return [...latest.values()];
}

export function Safety({ station }: { station: Station }) {
  const entries = station.journal.roster();
  const parcels = station.journal.parcels();
  const helping = helpers(station);
  const [query, setQuery] = useState('');
  const [heading, enableCompass] = useHeading();
  const [err, setErr] = useState('');
  const [replyErr, setReplyErr] = useState('');
  const me = station.position;
  const listening = station.status === 'listening';
  const name = (e: RosterEntry) => e.latest.body.about ?? who(station, e.latest.src, e.latest.body.nick);
  const by = (src: number, nick: string) => who(station, src, nick);
  const shown = search(entries, query, name, NEED_TEXT);
  const open = entries.filter((e) => e.open).length;

  const answer = (to: RosterEntry['latest'], what: ReplyKind) =>
    station.reply(to, what).then(
      () => setReplyErr(''),
      (e) => setReplyErr(message(e)),
    );

  const findMe = async () => {
    try {
      station.setPosition(await locate());
      setErr('');
    } catch (e) {
      setErr(message(e));
    }
  };

  const spreadsheet = () => {
    const csv = rosterCsv(entries, {
      name: (e) => e.latest.body.about ?? named(station, e.latest.src, e.latest.body.nick),
      by: (src, nick) => named(station, src, nick),
      status: STATUS_TEXT,
      need: NEED_TEXT,
    });
    download(new Blob([csv], { type: 'text/csv' }), `resonance-check-ins-${new Date().toISOString().slice(0, 16).replace(':', '')}.csv`);
  };

  return (
    <div class="safety">
      <FindPanel station={station} />
      <CheckInCard station={station} />

      {parcels.length > 0 && (
        <section aria-labelledby="courier-title">
          <h2 class="label" id="courier-title">
            Pass on to family outside
          </h2>
          <p class="muted small">Got signal? Your own text or mail app opens with the message filled in; nothing goes until you tap Send there.</p>
          <CourierList
            parcels={parcels}
            self={station.id}
            name={(src, nick) => named(station, src, nick)}
            passed={listening ? (p) => void answer(p.checkin, 'passed') : null}
          />
        </section>
      )}

      <section class="roster-section" aria-labelledby="roster-title">
        <div class="section-head">
          <h2 class="label" id="roster-title">
            Check-ins{entries.length > 0 && ` · ${entries.length} ${entries.length === 1 ? 'person' : 'people'} · ${open} open ${open === 1 ? 'request' : 'requests'}`}
          </h2>
          {entries.length > 0 && (
            <div class="row">
              <input type="search" value={query} placeholder="Find a name, place or need" aria-label="Search check-ins" onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
              <button type="button" class="ghost small" onClick={spreadsheet}>
                <Download size={14} /> Spreadsheet
              </button>
              <button type="button" class="ghost small" onClick={() => window.print()}>
                Print
              </button>
            </div>
          )}
        </div>
        {replyErr && (
          <p class="error small" role="alert">
            {replyErr}
          </p>
        )}
        {entries.length === 0 ? (
          <p class="empty small">No check-ins heard yet.</p>
        ) : shown.length === 0 ? (
          <p class="empty small">Nobody matches “{query}”.</p>
        ) : (
          <RosterList
            entries={shown}
            me={me}
            self={station.id}
            name={name}
            by={by}
            reply={listening ? (e, what) => void answer(e.latest, what) : null}
            find={(e) => {
              const n = e.latest.body.about ? undefined : station.mesh.neighbors.get(e.latest.src);
              return listening && n && Date.now() - n.lastHeard < FINDABLE_MS ? () => station.ranger.start(n.id) : null;
            }}
          />
        )}
      </section>

      {helping.length > 0 && (
        <section aria-labelledby="helpers-title">
          <h2 class="label" id="helpers-title">
            Who can help
          </h2>
          <HelperList helpers={helping} />
        </section>
      )}

      <section class="radar-wrap" aria-label="Who is where">
        {err && (
          <p class="error small" role="alert">
            {err}
          </p>
        )}
        {me ? (
          <>
            <Radar me={me} people={entries} heading={heading} name={name} />
            <div class="radar-actions">
              <button type="button" class="ghost small" onClick={() => void enableCompass()}>
                <Compass size={14} /> {heading === null ? 'Turn with my compass' : `Heading ${Math.round(heading)}°`}
              </button>
              <button type="button" class="ghost small" onClick={() => void findMe()}>
                <Pin size={14} /> Update my position
              </button>
            </div>
          </>
        ) : (
          <div class="empty">
            <p>Share your position to see who is where. GPS works with no internet; nothing leaves this device unless you check in.</p>
            <button type="button" class="ghost" onClick={() => void findMe()}>
              <Pin size={16} /> Use my position
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
