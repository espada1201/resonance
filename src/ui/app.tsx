import { useState } from 'preact/hooks';
import { BROADCAST } from '../mesh/packet';
import { PROFILES, type ProfileId, rawBitrate } from '../modem/profiles';
import { type Station, nodeHex } from '../station';
import { AirPanel, AirStatus } from './air';
import { Compose } from './compose';
import { Feed } from './feed';
import { useMedia, useStation, useTicker } from './hooks';
import { Logo, Mic } from './icons';
import { People } from './people';
import { Safety, latestCheckIns } from './safety';
import { Settings } from './settings';

const MODES: Array<[ProfileId, string, string]> = [
  ['audible', 'Audible', 'across a room'],
  ['fast', 'Fast', 'close, in a quiet room'],
  ['ultrasonic', 'Near-ultrasonic', 'same table, almost silent'],
];

type Tab = 'feed' | 'safety' | 'air' | 'people' | 'settings';
const TAB_TEXT: Record<Tab, string> = { feed: 'Feed', safety: 'Safety', air: 'Air', people: 'People', settings: 'Settings' };

function Gate({ station }: { station: Station }) {
  const sim = station.transport.kind === 'simulated';
  return (
    <section class="gate" aria-labelledby="gate-title">
      <p class="label">Offline mesh · made of sound</p>
      <h1 id="gate-title">Messages that travel through the air between the devices people already carry.</h1>
      <p class="lede">
        Resonance turns speakers and microphones into a radio. No internet, no cell signal, no pairing, no accounts. Every device that hears a
        message repeats it, so it hops across a crowd, down a stairwell, through a building.
      </p>
      {station.status === 'error' && (
        <p class="error" role="alert">
          {station.error} Check that this page may use the microphone, then try again.
        </p>
      )}
      <div class="gate-actions">
        <button type="button" class="primary large" onClick={() => void station.start()} disabled={station.status === 'starting'}>
          <Mic size={18} /> {station.status === 'starting' ? 'Starting…' : sim ? 'Join simulated air' : 'Start listening'}
        </button>
        {!sim && (
          <a class="button ghost large" href="?air=sim">
            Try it in two tabs, no microphone
          </a>
        )}
      </div>
      <p class="muted small">
        Your browser will ask for the microphone. Sound is decoded on this device and never recorded or uploaded. Echo cancellation is switched
        off on purpose: it would erase the chirps.
      </p>
      <dl class="gate-modes" aria-label="Three ways to send">
        {MODES.map(([id, name, range]) => (
          <div key={id}>
            <dt>{name}</dt>
            <dd class="rate">{Math.round(rawBitrate(PROFILES[id])).toLocaleString('en')} bit/s</dd>
            <dd>{range}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function App({ station }: { station: Station }) {
  useStation(station);
  useTicker(15_000);
  const wide = useMedia('(min-width: 960px)');
  const [tab, setTab] = useState<Tab>('feed');
  const [dst, setDst] = useState(BROADCAST);
  const tabs: Tab[] = wide ? ['feed', 'safety', 'people', 'settings'] : ['feed', 'safety', 'air', 'people', 'settings'];
  const current: Tab = !wide || tab !== 'air' ? tab : 'feed';
  const live = station.status === 'listening';
  const urgent = latestCheckIns(station.feed).filter((c) => c.body.status === 'help' || c.body.status === 'medical').length;

  const messageNode = (id: number) => {
    setDst(id);
    setTab('feed');
  };

  return (
    <div class={wide ? 'shell wide' : 'shell'}>
      <header class="top">
        <a class="brand" href="./" aria-label="Resonance home">
          <Logo size={22} />
          <span>Resonance</span>
        </a>
        <span class="node-chip" title="This device's id on the mesh">
          #{nodeHex(station.id)}
          {station.settings.nick && <b>{station.settings.nick}</b>}
        </span>
        {station.transport.kind === 'simulated' && <span class="chip sim">{wide ? 'Simulated air' : 'Sim'}</span>}
        <div class="top-right">{live && !wide ? <AirStatus station={station} compact /> : null}</div>
      </header>

      <nav class="tabs" role="tablist" aria-label="Sections">
        {tabs.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={current === t} onClick={() => setTab(t)}>
            {TAB_TEXT[t]}
            {t === 'safety' && urgent > 0 && <span class="badge" aria-label={`${urgent} need help`}>{urgent}</span>}
          </button>
        ))}
      </nav>

      <main class="main">
        <div class="left">
          <div class="scroll">
            {!live && current !== 'settings' && current !== 'air' && <Gate station={station} />}
            {current === 'feed' && (live || station.feed.length > 0) && <Feed station={station} />}
            {current === 'safety' && <Safety station={station} />}
            {current === 'people' && <People station={station} onMessage={messageNode} />}
            {current === 'settings' && <Settings station={station} />}
            {current === 'air' && <AirPanel station={station} />}
          </div>
          {current === 'feed' && live && <Compose station={station} dst={dst} setDst={setDst} />}
        </div>
        {wide && <AirPanel station={station} />}
      </main>
    </div>
  );
}
