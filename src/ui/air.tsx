import { useEffect, useRef } from 'preact/hooks';
import { PROFILES, type ProfileId, TONES_PER_GROUP } from '../modem/profiles';
import type { AirEvent, Station } from '../station';
import { clock, seconds } from './format';

// The waterfall shows the two slices of the spectrum Resonance actually uses, side by side,
// newest sound at the top. It is the app's way of making the invisible visible.

const BANDS: Array<{ id: ProfileId; lo: number; hi: number; share: number; name: string }> = [
  { id: 'audible', lo: 700, hi: 5000, share: 0.6, name: 'Audible' },
  { id: 'ultrasonic', lo: 17000, hi: 19700, share: 0.4, name: 'Quiet' },
];
const GAP = 0.02;
const ROW = 2;

const LUT = (() => {
  const stops: Array<[number, [number, number, number]]> = [
    [0, [9, 11, 10]],
    [0.35, [28, 40, 34]],
    [0.55, [96, 66, 18]],
    [0.75, [214, 140, 40]],
    [1, [255, 243, 214]],
  ];
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const j = stops.findIndex(([s]) => s >= t);
    const [s1, c1] = stops[Math.max(1, j)];
    const [s0, c0] = stops[Math.max(0, j - 1)];
    const f = s1 === s0 ? 0 : (t - s0) / (s1 - s0);
    for (let k = 0; k < 3; k++) lut[i * 3 + k] = c0[k] + (c1[k] - c0[k]) * f;
  }
  return lut;
})();

/** Maps a canvas column fraction to a frequency, or null inside the gap between bands. */
function columnHz(x: number): number | null {
  let start = 0;
  for (const b of BANDS) {
    const w = b.share - GAP / 2;
    if (x >= start && x < start + w) return b.lo + ((x - start) / w) * (b.hi - b.lo);
    start += b.share + GAP / 2;
  }
  return null;
}

export function Waterfall({ station, height = 220 }: { station: Station; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    let columns: Array<number | null> = [];
    const resize = () => {
      const w = Math.max(1, Math.round(canvas.clientWidth * Math.min(2, devicePixelRatio)));
      if (canvas.width === w) return;
      canvas.width = w;
      canvas.height = Math.round(height * Math.min(2, devicePixelRatio));
      ctx.fillStyle = '#090b0a';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      columns = Array.from({ length: w }, (_, x) => columnHz(x / w));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    const off = station.onSpectrum(({ bins, fs }) => {
      const w = canvas.width;
      ctx.drawImage(canvas, 0, 0, w, canvas.height - ROW, 0, ROW, w, canvas.height - ROW);
      const row = ctx.createImageData(w, ROW);
      const binHz = fs / 2 / bins.length;
      for (let x = 0; x < w; x++) {
        const hz = columns[x];
        let r = 9, g = 11, b = 10;
        if (hz === null) {
          r = g = b = 22;
        } else {
          const db = bins[Math.min(bins.length - 1, Math.round(hz / binHz))];
          const v = Math.max(0, Math.min(255, ((db + 105) / 70) * 255)) | 0;
          r = LUT[v * 3];
          g = LUT[v * 3 + 1];
          b = LUT[v * 3 + 2];
        }
        for (let y = 0; y < ROW; y++) {
          const o = (y * w + x) * 4;
          row.data[o] = r;
          row.data[o + 1] = g;
          row.data[o + 2] = b;
          row.data[o + 3] = 255;
        }
      }
      ctx.putImageData(row, 0, 0);
    });
    return () => {
      off();
      ro.disconnect();
    };
  }, [station, height]);

  const active = station.transmitting?.profile ?? station.receiving;
  return (
    <figure class="waterfall">
      <canvas ref={ref} style={{ height: `${height}px` }} role="img" aria-label="Live spectrum of the microphone, newest sound at the top" />
      <figcaption class="bands">
        {BANDS.map((b) => {
          const p = PROFILES[b.id];
          const lo = (p.baseHz / 1000).toFixed(1);
          const hi = ((p.baseHz + p.binHz * (p.hopSets * p.groups * TONES_PER_GROUP - 1)) / 1000).toFixed(1);
          return (
            <span key={b.id} style={{ flex: b.share }} class={active === b.id ? (station.transmitting ? 'band tx' : 'band rx') : 'band'}>
              <b>{b.name}</b> {lo}–{hi} kHz
            </span>
          );
        })}
      </figcaption>
    </figure>
  );
}

function stateLine(s: Station): { text: string; tone: 'idle' | 'rx' | 'tx' | 'warn' } {
  if (s.status === 'error') return { text: 'Microphone unavailable', tone: 'warn' };
  if (s.status !== 'listening') return { text: s.status === 'starting' ? 'Starting audio…' : 'Not listening', tone: 'idle' };
  if (s.transmitting) return { text: `Transmitting · ${seconds(s.transmitting.seconds)}`, tone: 'tx' };
  if (s.receiving) return { text: `Receiving ${s.receiving === 'audible' ? 'audible' : 'quiet'} frame…`, tone: 'rx' };
  return { text: s.radio.length ? `Waiting for clear air · ${s.radio.length} queued` : 'Listening', tone: 'idle' };
}

export function AirStatus({ station }: { station: Station }) {
  const st = stateLine(station);
  return (
    <div class={`air-status ${st.tone}`} role="status" aria-live="polite">
      <span class="dot" aria-hidden="true" />
      {st.text}
      {station.transmitting && <TxProgress started={station.transmitting.started} seconds={station.transmitting.seconds} />}
    </div>
  );
}

function TxProgress({ started, seconds: total }: { started: number; seconds: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    const step = () => {
      const f = Math.min(1, (Date.now() - started) / 1000 / total);
      if (ref.current) ref.current.style.transform = `scaleX(${f})`;
      if (f < 1) raf = requestAnimationFrame(step);
    };
    step();
    return () => cancelAnimationFrame(raf);
  }, [started, total]);
  return (
    <span class="tx-progress" aria-hidden="true">
      <span ref={ref} />
    </span>
  );
}

export function AirStats({ station }: { station: Station }) {
  const t = station.totals;
  const m = station.mesh.stats;
  const goodput = t.rxSec > 0 ? `${Math.round(t.rxBits / t.rxSec)} bps` : '—';
  const last = station.air.find((e) => e.dir === 'rx');
  const cells: Array<[string, string, string?]> = [
    ['Measured in', goodput, 'payload bits ÷ seconds on air, over every frame decoded'],
    ['Sent', t.txSec ? seconds(t.txSec) : '—', 'total time this device spent transmitting'],
    ['Tone SNR', last?.toneSnrDb !== undefined ? `${last.toneSnrDb.toFixed(0)} dB` : '—'],
    ['Heard', `${m.heard}`],
    ['Relayed', `${m.relayed + m.carried}`],
    ['Lost', `${t.lost}`, 'frames detected but too damaged to repair'],
  ];
  return (
    <dl class="stats">
      {cells.map(([k, v, title]) => (
        <div key={k} title={title}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const DIR_TEXT: Record<AirEvent['dir'], string> = { rx: 'IN', tx: 'OUT', sync: 'SYNC', lost: 'LOST' };

export function AirLog({ events, limit = 60 }: { events: AirEvent[]; limit?: number }) {
  if (!events.length) {
    return <p class="empty small">Nothing on the air yet. Decoded frames, relays and failed attempts will show up here with honest numbers.</p>;
  }
  return (
    <ol class="airlog" aria-label="Air activity">
      {events.slice(0, limit).map((e) => (
        <li key={e.id} class={e.dir}>
          <span class="dir">{DIR_TEXT[e.dir]}</span>
          <span class="what">
            {e.label}
            <span class="meta">
              {e.profile === 'audible' ? 'audible' : 'quiet'}
              {e.bytes !== undefined && ` · ${e.bytes} B`}
              {e.airtimeSec !== undefined && ` · ${e.airtimeSec.toFixed(1)} s`}
              {e.bytes !== undefined && e.airtimeSec ? ` · ${Math.round((e.bytes * 8) / e.airtimeSec)} bps` : ''}
              {e.toneSnrDb !== undefined && ` · SNR ${e.toneSnrDb.toFixed(0)} dB`}
              {e.corrected ? ` · repaired ${e.corrected} B` : ''}
              {e.clockRatio !== undefined && Math.abs(e.clockRatio - 1) > 0.0002 ? ` · clock ${((e.clockRatio - 1) * 100).toFixed(2)}%` : ''}
            </span>
          </span>
          <time>{clock(e.at)}</time>
        </li>
      ))}
    </ol>
  );
}

export function AirPanel({ station }: { station: Station }) {
  return (
    <section class="airpanel" aria-label="Air">
      <div class="air-head">
        <span class="label">The air</span>
        <AirStatus station={station} />
      </div>
      <Waterfall station={station} />
      <AirStats station={station} />
      <div class="air-log-wrap">
        <AirLog events={station.air} />
      </div>
    </section>
  );
}
