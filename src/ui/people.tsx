import { nodeHex } from '../mesh/packet';
import type { Station } from '../station';
import { who } from './feed';
import { ago } from './format';
import { FindPanel } from './find';
import { Compass, Relay, Send } from './icons';
import { linkWords } from './links';
import { StatGrid } from './shell';

export function People({ station, onMessage }: { station: Station; onMessage: (id: number) => void }) {
  const ns = [...station.mesh.neighbors.values()].sort((a, b) => b.lastHeard - a.lastHeard);
  const s = station.mesh.stats;
  const stats: Array<[string, number, string]> = [
    ['Heard', s.heard, 'packets decoded off the air'],
    ['Delivered', s.delivered, 'new messages for you or everyone'],
    ['Relayed', s.relayed, 'packets this device repeated for others'],
    ['Held back', s.suppressed, 'relays skipped because enough neighbours already repeated them'],
    ['Carried', s.carried, 'stored packets sent again for newcomers who lacked them'],
    ['Stored', station.mesh.store.size, 'packets kept to pass on to people who arrive later'],
  ];
  return (
    <div class="people-tab">
      <FindPanel station={station} />
      <section class="me-card">
        <span class="label">This device</span>
        <p class="node-id">#{nodeHex(station.id)}</p>
        <p class="muted small">
          {station.settings.nick ? `Known as "${station.settings.nick}". ` : 'No nickname yet. Set one in Settings. '}
          {station.mesh.config.relay ? 'Relaying for others.' : 'Not relaying for others.'}
        </p>
      </section>

      <StatGrid variant="wide" cells={stats} />

      <h2 class="label">Heard directly</h2>
      {ns.length === 0 ? (
        <p class="empty small">Nobody heard directly yet. Devices say hello every few minutes, beacons every minute.</p>
      ) : (
        <ul class="nodes">
          {ns.map((n) => (
            <li key={n.id}>
              <span class="who">
                {who(station, n.id, n.nick)}
                {n.role === 'beacon' && (
                  <span class="chip beacon">
                    <Relay size={12} /> beacon
                  </span>
                )}
              </span>
              <span class="muted small">{[`#${nodeHex(n.id)}`, ago(n.lastHeard), linkWords(station, n.id)].filter(Boolean).join(' · ')}</span>
              <span class="node-actions">
                <button
                  type="button"
                  class="ghost small"
                  disabled={station.status !== 'listening'}
                  onClick={() => station.ranger.start(n.id)}
                  aria-label={`Find ${who(station, n.id, n.nick)}: measure the distance by sound`}
                >
                  <Compass size={14} /> Find
                </button>
                <button type="button" class="ghost small" onClick={() => onMessage(n.id)} aria-label={`Message ${who(station, n.id, n.nick)} directly`}>
                  <Send size={14} /> Message
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <p class="muted small">
        Other devices still relay direct messages, but only the recipient's device shows them and sends back a receipt. With no receipt, the sender
        tries twice more.
      </p>
    </div>
  );
}
