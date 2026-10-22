import type { Station } from '../station';
import { named } from './feed';
import { PROFILE_NAME, STRENGTH_TEXT } from './format';

/** "Strong signal · Audible": how one neighbour comes across, from the frames it sent itself. */
export function linkWords(station: Station, id: number): string | null {
  const l = station.links.get(id);
  return l && `${STRENGTH_TEXT[l.strength]} · ${PROFILE_NAME[l.profile]}`;
}

/** One line on whether it is working: who is heard directly, and what to do about a weak link. */
export function LinkDoctor({ station }: { station: Station }) {
  const heard = [...station.mesh.neighbors.values()]
    .map((n) => ({ n, l: station.links.get(n.id) }))
    .filter((x) => x.l)
    .sort((a, b) => b.l!.at - a.l!.at);
  if (!heard.length) {
    return <p class="link-doctor muted small">Nobody heard directly yet. Devices say hello every few minutes, beacons every minute.</p>;
  }
  const weak = heard.filter((x) => x.l!.strength === 'weak');
  return (
    <p class="link-doctor small">
      Hearing {heard.map(({ n, l }) => `${named(station, n.id, n.nick)} (${l!.strength}, ${PROFILE_NAME[l!.profile]})`).join(', ')}.
      {weak.length > 0 &&
        ` A weak signal loses frames: move closer, turn the volume up${weak.some((x) => x.l!.profile !== 'audible') ? ', or send in Audible' : ''}.`}
    </p>
  );
}
