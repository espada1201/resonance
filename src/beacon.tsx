import { render } from 'preact';
import { useState } from 'preact/hooks';
import { boot, useAutoStart } from './boot';
import { nodeHex } from './mesh/packet';
import { MAX_NICK } from './mesh/payloads';
import { AirLog, AirStatus, Waterfall } from './ui/air';
import { named } from './ui/feed';
import { errorText, fitInput } from './ui/format';
import { useMedia, useStation, useTicker } from './ui/hooks';
import { Mic } from './ui/icons';
import { NoticeBoard, type NoticeDraft, NoticeFields, newNotice } from './ui/notices';
import { RosterList, headcount } from './ui/roster';
import { StatGrid, TopBar } from './ui/shell';
import './ui/styles/index.css';

// A laptop left in a hallway: listens forever, relays everything, and hands stored messages
// to phones that come within earshot (they trade hellos, then each sends what the other lacks).

const station = boot('beacon');
// Its notices are signed with this, as a person's are with their nickname.
if (!station.settings.nick) station.update({ nick: 'Beacon' });

function uptime(ms: number) {
  const m = Math.floor(ms / 60_000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** A notice from the desk the beacon sits on: water, food, danger, for everyone in earshot. */
function NoticeForm() {
  const [notice, setNotice] = useState<NoticeDraft>(newNotice);
  const [err, setErr] = useState('');
  const [working, setWorking] = useState(false);
  const room = station.budget({ kind: 'notice', ...notice }).left;

  async function submit(e: Event) {
    e.preventDefault();
    setWorking(true);
    setErr('');
    try {
      await station.say({ kind: 'notice', ...notice, place: notice.place.trim(), text: notice.text.trim() });
      setNotice(newNotice());
    } catch (x) {
      setErr(errorText(x));
    }
    setWorking(false);
  }

  return (
    <form class="beacon-notice" aria-labelledby="notice-title" onSubmit={submit}>
      <h2 class="label" id="notice-title">
        Post a notice
      </h2>
      <label class="field">
        <span class="label">Sign as</span>
        <input value={station.settings.nick} maxLength={MAX_NICK} onInput={(e) => station.update({ nick: fitInput(e, MAX_NICK) })} />
      </label>
      <NoticeFields draft={notice} set={(patch) => setNotice((d) => ({ ...d, ...patch }))} room={room} />
      <button type="submit" class="primary" disabled={working || !notice.text.trim() || room < 0}>
        {working ? 'Posting…' : 'Post notice'}
      </button>
      {err && (
        <p class="error small" role="alert">
          {err}
        </p>
      )}
    </form>
  );
}

function Beacon() {
  useStation(station);
  useAutoStart(station);
  useTicker(5_000);
  const narrow = useMedia('(max-width: 600px)');
  const m = station.mesh.stats;
  const live = station.status === 'listening';
  const entries = station.journal.roster();
  const by = (src: number, nick: string) => named(station, src, nick);
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
      <TopBar station={station} compact={narrow} right={live && <AirStatus station={station} compact={narrow} announce />}>
        <span class="chip beacon">Beacon #{nodeHex(station.id)}</span>
      </TopBar>
      <main class="beacon-main">
        {!live && (
          <section class="gate">
            <h2>Leave this device here as a relay.</h2>
            <p class="lede">
              It listens in all three modes, repeats every message it hears, keeps the newest 300 packets (check-ins and notices for three days,
              the rest for 12 hours) and hands them to any phone that comes within earshot. Plug it in, turn the volume up, keep the lid open.
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
        <NoticeBoard large notices={station.journal.notices()} by={by} />
        <StatGrid variant="huge" cells={cells} />
        <section aria-labelledby="roster-title">
          <h2 class="label" id="roster-title">
            Check-ins{entries.length > 0 && ` · ${headcount(entries)}`}
          </h2>
          {entries.length === 0 ? (
            <p class="empty small">No check-ins heard yet.</p>
          ) : (
            <RosterList
              entries={entries}
              me={null}
              self={station.id}
              name={(e) => e.latest.body.about ?? by(e.latest.src, e.latest.body.nick)}
              by={by}
              reply={null}
              find={() => null}
            />
          )}
        </section>
        {live && <NoticeForm />}
        <Waterfall station={station} height={260} />
        <AirLog events={station.air} limit={40} />
      </main>
    </div>
  );
}

render(<Beacon />, document.getElementById('app')!);
