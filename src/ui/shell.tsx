import type { ComponentChildren } from 'preact';
import type { Station } from '../station';
import { Logo } from './icons';

/** The bar across the top of the app and the beacon: the name, this device, and the state of the air. */
export function TopBar({
  station,
  compact,
  homeLabel,
  children,
  right,
}: {
  station: Station;
  compact: boolean;
  homeLabel?: string;
  children?: ComponentChildren;
  right?: ComponentChildren;
}) {
  return (
    <header class="top">
      <a class="brand" href="./" aria-label={homeLabel}>
        <Logo size={22} />
        <span>Resonance</span>
      </a>
      {children}
      {station.transport.kind === 'simulated' && <span class="chip sim">{compact ? 'Sim' : 'Simulated air'}</span>}
      <div class="top-right">{right}</div>
    </header>
  );
}

/** Counters in a grid; a hint, where given, says what one counts. */
export function StatGrid({ cells, variant }: { cells: Array<[label: string, value: string | number, hint?: string]>; variant?: 'wide' | 'huge' }) {
  return (
    <dl class={variant ? `stats ${variant}` : 'stats'}>
      {cells.map(([label, value, hint]) => (
        <div key={label} title={hint}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
