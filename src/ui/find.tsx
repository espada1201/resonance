import type { Station } from '../station';
import { who } from './feed';
import { Cross } from './icons';

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const w = 240;
  const h = 48;
  const max = Math.max(...values) * 1.1 || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - (v / max) * h}`).join(' ');
  return (
    <svg class="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="Recent distance readings">
      <polyline points={pts} />
    </svg>
  );
}

const fmt = (m: number) => (m < 10 ? m.toFixed(2) : m.toFixed(1));

/** Avalanche-beacon style readout of the live distance to one device. */
export function FindPanel({ station }: { station: Station }) {
  const f = station.ranger.find;
  if (!f) return null;
  const readings = f.readings;
  const last = readings.at(-1);
  const prev = readings.slice(-4, -1);
  const base = prev.length ? prev.reduce((a, b) => a + b, 0) / prev.length : null;
  const delta = last !== undefined && base !== null ? last - base : null;
  const trend = delta === null || Math.abs(delta) < 0.15 ? 'steady' : delta < 0 ? 'closer' : 'further';
  const phase = f.phase === 'pinging' ? 'Pinging' : f.phase === 'waiting' ? 'Listening for the answer' : 'Next ping in a moment';
  return (
    <section class="find" aria-label={`Distance to ${who(station, f.target)}`} aria-live="polite">
      <header>
        <span class="label">Finding {who(station, f.target)}</span>
        <button type="button" class="ghost small" onClick={() => station.ranger.stop()}>
          <Cross size={14} /> Stop
        </button>
      </header>
      <p class="distance">
        {last === undefined ? '—' : fmt(last)}
        <span class="unit">m</span>
      </p>
      <p class={`trend ${trend}`}>
        {last === undefined ? phase : trend === 'steady' ? 'Holding steady' : `Getting ${trend} · ${Math.abs(delta!).toFixed(1)} m`}
      </p>
      <Sparkline values={readings} />
      <p class="muted small">
        {f.note || `${phase}. ${readings.length} reading${readings.length === 1 ? '' : 's'}.`} Find measures the distance by timing chirps sent back and
        forth between the two devices. Sound covers about a metre every 3 milliseconds. Find needs no GPS and works indoors. As you walk towards them,
        the number goes down.
      </p>
    </section>
  );
}
