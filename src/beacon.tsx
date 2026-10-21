import { render } from 'preact';
import { useEffect } from 'preact/hooks';
import { MicTransport, SimulatedAir } from './audio/transport';
import { Station, nodeHex } from './station';
import { AirLog, AirStatus, Waterfall } from './ui/air';
import { useStation, useTicker } from './ui/hooks';
import { Logo, Mic } from './ui/icons';
import './ui/styles.css';

// A laptop left in a hallway: listens forever, relays everything, and hands stored messages
// to anyone who walks past and says hello.

const params = new URLSearchParams(location.search);
const sim = params.get('air') === 'sim';
const [x = 0, y = 0] = (params.get('at') ?? '').split(',').map(Number).filter(Number.isFinite);
const station = new Station(sim ? new SimulatedAir({ x, y }) : new MicTransport(), 'beacon', sim ? null : undefined);

function uptime(ms: number) {
  const m = Math.floor(ms / 60_000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function Beacon() {
  useStation(station);
  useTicker(5_000);
  useEffect(() => {
    if (sim) void station.start();
  }, []);
  const m = station.mesh.stats;
  const live = station.status === 'listening';
  const cells: Array<[string, string | number]> = [
    ['Heard', m.heard],
    ['Relayed', m.relayed],
    ['Carried', m.carried],
    ['Stored', station.mesh.store.size],
    ['Neighbours', station.mesh.neighbors.size],
    ['Up', live ? uptime(Date.now() - station.startedAt) : '—'],
  ];
  return (
    <div class="beacon-page">
      <header class="top">
        <a class="brand" href="./">
          <Logo size={22} />
          <span>Resonance</span>
        </a>
        <span class="chip beacon">Beacon #{nodeHex(station.id)}</span>
        {sim && <span class="chip sim">Simulated air</span>}
        <div class="top-right">{live && <AirStatus station={station} />}</div>
      </header>
      <main class="beacon-main">
        {!live && (
          <section class="gate">
            <h1>Leave this device here as a relay.</h1>
            <p class="lede">
              It listens in all three modes, repeats every message it hears, stores them for 12 hours and hands them to any phone that comes within
              earshot. Plug it in, turn the volume up, keep the lid open.
            </p>
            {station.status === 'error' && <p class="error" role="alert">{station.error}</p>}
            <button
              type="button"
              class="primary large"
              onClick={() => void station.start()}
            >
              <Mic size={18} /> Start beacon
            </button>
          </section>
        )}
        <dl class="stats huge">
          {cells.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <Waterfall station={station} height={260} />
        <AirLog events={station.air} limit={40} />
      </main>
    </div>
  );
}

render(<Beacon />, document.getElementById('app')!);
