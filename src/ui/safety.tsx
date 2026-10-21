import { useEffect, useState } from 'preact/hooks';
import { bearingDeg, compassPoint, distanceM, formatDistance, locate } from '../geo';
import type { Geo, Status } from '../mesh/payloads';
import { type FeedItem, type Station, nodeHex } from '../station';
import { who } from './feed';
import { STATUS_TEXT, ago } from './format';
import { Compass, Pin } from './icons';

type CheckIn = FeedItem & { body: Extract<NonNullable<FeedItem['body']>, { kind: 'checkin' }> };
const URGENCY: Record<Status, number> = { help: 0, medical: 1, sheltering: 2, safe: 3 };

/** Latest check-in per person, most urgent first. */
export function latestCheckIns(feed: FeedItem[]): CheckIn[] {
  const by = new Map<number, CheckIn>();
  for (const i of feed) if (i.body?.kind === 'checkin' && !by.has(i.src)) by.set(i.src, i as CheckIn);
  return [...by.values()].sort((a, b) => URGENCY[a.body.status] - URGENCY[b.body.status] || b.at - a.at);
}

const NICE = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 20_000, 50_000];
const ringLabel = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${+(m / 1000).toFixed(1)} km`);

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

function Radar({ me, people, heading }: { me: Geo; people: CheckIn[]; heading: number | null }) {
  const pts = people.filter((p) => p.body.geo).map((p) => ({ p, d: distanceM(me, p.body.geo!), b: bearingDeg(me, p.body.geo!) }));
  const far = Math.max(20, ...pts.map((x) => x.d)) * 1.1;
  const max = NICE.find((n) => n >= far) ?? far;
  const R = 130;
  const rot = heading ?? 0;
  const scale = (d: number) => (Math.sqrt(d / max) * R);
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
        {pts.map(({ p, d, b }) => {
          const a = (b * Math.PI) / 180;
          const r = scale(d);
          return (
            <g key={p.id} transform={`translate(${Math.sin(a) * r} ${-Math.cos(a) * r})`} class={`blip s-${p.body.status}`}>
              <circle r={6} />
              <text x={9} y={4} transform={`rotate(${rot})`}>
                {p.body.nick || `#${nodeHex(p.src).slice(0, 4)}`}
              </text>
            </g>
          );
        })}
      </g>
      <circle r={4} class="me" />
    </svg>
  );
}

export function Safety({ station }: { station: Station }) {
  const people = latestCheckIns(station.feed);
  const [heading, enableCompass] = useHeading();
  const [err, setErr] = useState('');
  const [sending, setSending] = useState<Status | null>(null);
  const me = station.position;

  const quick = async (status: Status) => {
    setSending(status);
    setErr('');
    let geo: Geo | undefined;
    try {
      geo = await locate(8000);
      station.setPosition(geo);
    } catch (e) {
      setErr(`${e instanceof Error ? e.message : e} Sent without a position.`);
    }
    try {
      await station.sendCheckIn(status, '', geo);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setSending(null);
  };

  const findMe = async () => {
    try {
      station.setPosition(await locate());
      setErr('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const listening = station.status === 'listening';
  return (
    <div class="safety">
      <div class="quick">
        <button type="button" class="big s-safe" disabled={!listening || !!sending} onClick={() => void quick('safe')}>
          {sending === 'safe' ? 'Sending…' : "I'm safe"}
        </button>
        <button type="button" class="big s-help" disabled={!listening || !!sending} onClick={() => void quick('help')}>
          {sending === 'help' ? 'Sending…' : 'I need help'}
        </button>
      </div>
      <p class="muted small">One tap broadcasts your status (with GPS if allowed) to everyone in earshot. Other devices relay it onward.</p>
      {err && <p class="error small" role="alert">{err}</p>}

      <section class="radar-wrap" aria-label="Who is where">
        {me ? (
          <>
            <Radar me={me} people={people} heading={heading} />
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

      <ul class="people">
        {people.length === 0 && <li class="empty small">No check-ins heard yet.</li>}
        {people.map((p) => {
          const g = p.body.geo;
          const d = g && me ? distanceM(me, g) : null;
          const rel = g && me && d !== null ? (d < 10 ? 'right next to you' : `${formatDistance(d)} ${compassPoint(bearingDeg(me, g))}`) : g ? 'position attached' : 'no position';
          return (
            <li key={p.id} class={`s-${p.body.status}`}>
              <span class="status-word">{STATUS_TEXT[p.body.status]}</span>
              <span class="who">{who(station, p.src, p.body.nick)}</span>
              <span class="muted small">
                {rel} · {ago(p.at)}
                {p.body.note && ` · ${p.body.note}`}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
