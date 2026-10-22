import { useState } from 'preact/hooks';
import { useAutoStart } from '../boot';
import { BROADCAST } from '../mesh/packet';
import { PROFILES, type ProfileId, rawBitrate } from '../modem/profiles';
import { type Station, nodeHex } from '../station';
import { AirPanel, AirStatus } from './air';
import { Compose } from './compose';
import { Feed } from './feed';
import { rovingKeys, useMedia, useStation, useTicker } from './hooks';
import { Mic } from './icons';
import { People } from './people';
import { Safety } from './safety';
import { Settings } from './settings';
import { TopBar } from './shell';

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
          {station.error}
        </p>
      )}
      <div class="gate-actions">
        <button type="button" class="primary large" onClick={() => void station.start()} disabled={station.status === 'starting'}>
          <Mic size={18} /> {station.status === 'starting' ? 'Starting…' : sim ? 'Join simulated air' : 'Start listening'}
        </button>
        {!sim && (
          // This tab joins the simulated room, and a second one opens beside it, 3 m away.
          <a class="button ghost large" href="?air=sim" onClick={() => window.open('?air=sim&at=3,0', '_blank')}>
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
            <dd class="rate">{Math.round(rawBitrate(PROFILES[id])).toLocaleString('en')} bit/s raw</dd>
            <dd>{range}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function App({ station }: { station: Station }) {
  useStation(station);
  useAutoStart(station);
  useTicker(15_000);
  const wide = useMedia('(min-width: 960px)');
  const [tab, setTab] = useState<Tab>('feed');
  const [dst, setDst] = useState(BROADCAST);
  const tabs: Tab[] = wide ? ['feed', 'safety', 'people', 'settings'] : ['feed', 'safety', 'air', 'people', 'settings'];
  const current: Tab = !wide || tab !== 'air' ? tab : 'feed';
  const live = station.status === 'listening';
  const open = station.journal.roster().filter((e) => e.open).length;

  const messageNode = (id: number) => {
    setDst(id);
    setTab('feed');
  };

  return (
    <div class={wide ? 'shell wide' : 'shell'}>
      <TopBar station={station} compact={!wide} homeLabel="Resonance home" right={live && !wide ? <AirStatus station={station} compact announce /> : null}>
        <span class="node-chip" title="This device's id on the mesh">
          #{nodeHex(station.id)}
          {station.settings.nick && <b>{station.settings.nick}</b>}
        </span>
      </TopBar>

      <nav class="tabs" role="tablist" aria-label="Sections" onKeyDown={rovingKeys(tabs, current, setTab)}>
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            id={`tab-${t}`}
            aria-selected={current === t}
            aria-controls="section"
            tabIndex={current === t ? 0 : -1}
            aria-label={t === 'safety' && open > 0 ? `Safety, ${open} open request${open > 1 ? 's' : ''}` : undefined}
            onClick={() => setTab(t)}
          >
            {TAB_TEXT[t]}
            {t === 'safety' && open > 0 && <span class="badge">{open}</span>}
          </button>
        ))}
      </nav>

      <main class="main">
        <div class="left">
          <div class="scroll" role="tabpanel" id="section" aria-labelledby={`tab-${current}`}>
            {!live && current !== 'settings' && current !== 'air' && <Gate station={station} />}
            {current === 'feed' && (live || station.journal.feed.length > 0) && <Feed station={station} />}
            {current === 'safety' && <Safety station={station} />}
            {current === 'people' && <People station={station} onMessage={messageNode} />}
            {current === 'settings' && <Settings station={station} />}
            {current === 'air' && <AirPanel station={station} />}
          </div>
          {current === 'feed' && live && <Compose station={station} dst={dst} setDst={setDst} />}
        </div>
        {wide && <AirPanel station={station} announce />}
      </main>
    </div>
  );
}
