import { useEffect, useRef, useState } from 'preact/hooks';
import { useAutoStart } from '../boot';
import { BROADCAST, nodeHex } from '../mesh/packet';
import type { ProfileId } from '../modem/profiles';
import { type RosterEntry, needingYou } from '../roster';
import type { Station } from '../station';
import { AirPanel, AirStatus } from './air';
import { Compose, focusCompose } from './compose';
import { Feed, who } from './feed';
import { STATUS_TEXT } from './format';
import { rovingKeys, useMedia, useStation, useTicker } from './hooks';
import { Mic } from './icons';
import { People } from './people';
import { Safety } from './safety';
import { Settings } from './settings';
import { TopBar } from './shell';

const MODES: Array<[ProfileId, string, string]> = [
  ['audible', 'Audible', 'across a room'],
  ['fast', 'Fast', 'close, in a quiet room, fastest'],
  ['ultrasonic', 'Quiet', 'same table, almost silent, slowest'],
];

type Tab = 'feed' | 'safety' | 'air' | 'people' | 'settings';
const TAB_TEXT: Record<Tab, string> = { feed: 'Feed', safety: 'Safety', air: 'Sound', people: 'People', settings: 'Settings' };

function Gate({ station }: { station: Station }) {
  const sim = station.transport.kind === 'simulated';
  return (
    <section class="gate" aria-labelledby="gate-title">
      <p class="label">Works with no internet or signal</p>
      <h2 id="gate-title">Messages that travel by sound between the phones people already carry.</h2>
      <p class="lede">
        Your phone plays a message as a short burst of sound. Phones nearby hear it and play it on, so it crosses a room, a building or a crowd. No
        internet, cell signal, pairing or account needed.
      </p>
      <p class="lede">
        In an emergency, open <strong>Safety</strong> and tap <strong>I'm safe</strong> or <strong>I need help</strong>. Everyone nearby sees who
        is safe, who needs help, and where.
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
            Try a demo, no microphone needed
          </a>
        )}
      </div>
      <p class="muted small">
        Your browser will ask to use the microphone. Resonance listens for its own messages on this device and never records or uploads sound.
      </p>
      <details class="more">
        <summary>Three ways to send, from across a room to almost silent</summary>
        <dl class="gate-modes" aria-label="Three ways to send">
          {MODES.map(([id, name, range]) => (
            <div key={id}>
              <dt>{name}</dt>
              <dd>{range}</dd>
            </div>
          ))}
        </dl>
      </details>
    </section>
  );
}

/**
 * A call for help heard while the page is open, that nobody is coming to yet, buzzes the phone
 * (where the browser can), and screen readers say it: a phone left on a table must not keep it
 * to itself. The count of open requests from others shows in the page title and on the home-screen icon.
 */
function useCallsForHelp(station: Station, entries: RosterEntry[]) {
  const [opened] = useState(() => Date.now());
  const told = useRef(new Set<string>());
  const [said, setSaid] = useState('');
  // Your own call for help is not something for you to act on: it stays out of the count.
  const open = needingYou(entries, station.id).length;
  const calls = entries.filter((e) => e.open && !e.coming && e.latest.src !== station.id && e.latest.at >= opened);
  const ids = calls.map((e) => `${e.latest.src}:${e.latest.msgId}`);
  useEffect(() => {
    const fresh = calls.filter((_, i) => !told.current.has(ids[i]));
    if (!fresh.length) return;
    for (const id of ids) told.current.add(id);
    if ('vibrate' in navigator) navigator.vibrate([300, 150, 300]);
    setSaid(fresh.map((e) => `${STATUS_TEXT[e.latest.body.status]}: ${e.latest.body.about ?? who(station, e.latest.src, e.latest.body.nick)}`).join('. '));
  }, [ids.join()]);
  useEffect(() => {
    document.title = open ? `(${open}) Resonance` : 'Resonance';
    if ('setAppBadge' in navigator) void (open ? navigator.setAppBadge(open) : navigator.clearAppBadge()).catch(() => undefined);
  }, [open]);
  return { open, said };
}

export function App({ station }: { station: Station }) {
  useStation(station);
  useAutoStart(station);
  useTicker(15_000);
  const wide = useMedia('(min-width: 960px)');
  const [tab, setTab] = useState<Tab>('feed');
  const [dst, setDst] = useState(BROADCAST);
  const [writing, setWriting] = useState(false);
  const tabs: Tab[] = wide ? ['feed', 'safety', 'people', 'settings'] : ['feed', 'safety', 'air', 'people', 'settings'];
  const current: Tab = !wide || tab !== 'air' ? tab : 'feed';
  const live = station.status === 'listening';
  const { open, said } = useCallsForHelp(station, station.journal.roster());

  const messageNode = (id: number) => {
    setDst(id);
    setTab('feed');
    setWriting(true);
  };
  const composing = current === 'feed' && live;

  return (
    <div class={wide ? 'shell wide' : 'shell'}>
      {composing && (
        <a
          class="skip"
          href="#compose"
          onClick={(e) => {
            e.preventDefault();
            focusCompose();
          }}
        >
          Skip to the message box
        </a>
      )}
      <TopBar station={station} compact={!wide} homeLabel="Resonance home" right={live && !wide ? <AirStatus station={station} compact announce /> : null}>
        <span class="node-chip" title="This device's id on the mesh">
          #{nodeHex(station.id)}
          {station.settings.nick && <b>{station.settings.nick}</b>}
        </span>
      </TopBar>

      <nav>
        <div class="tabs" role="tablist" aria-label="Sections" onKeyDown={rovingKeys(tabs, current, setTab)}>
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
        </div>
        {/* Shown only while the keyboard is on a tab: a touch screen never sees it. */}
        <p class="key-hint tabs-hint" aria-hidden="true">
          Arrow keys switch tabs
        </p>
      </nav>

      <p class="sr-only" aria-live="assertive">
        {said}
      </p>

      <main class="main">
        <div class="left">
          <div class="scroll" role="tabpanel" id="section" aria-labelledby={`tab-${current}`}>
            {!live && current !== 'settings' && current !== 'air' && <Gate station={station} />}
            {current === 'feed' && (live || station.journal.feed.length > 0) && <Feed station={station} onReply={live ? messageNode : undefined} />}
            {current === 'safety' && <Safety station={station} />}
            {current === 'people' && <People station={station} onMessage={messageNode} />}
            {current === 'settings' && <Settings station={station} />}
            {current === 'air' && <AirPanel station={station} />}
          </div>
          {composing && <Compose station={station} dst={dst} setDst={setDst} writing={writing} wrote={() => setWriting(false)} />}
        </div>
        {wide && <AirPanel station={station} announce />}
      </main>
    </div>
  );
}
