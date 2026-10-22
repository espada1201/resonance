import { useEffect } from 'preact/hooks';
import { MicTransport, SimulatedAir } from './audio/transport';
import { type Role, Station } from './station';

/**
 * The station for this page, and the service worker that lets it open offline. ?air=sim swaps the
 * microphone for a simulated room shared by every tab of this browser; ?at=x,y places the tab in it.
 */
export function boot(role: Role): Station {
  const params = new URLSearchParams(location.search);
  const sim = params.get('air') === 'sim';
  const [x = 0, y = 0] = (params.get('at') ?? '').split(',').map(Number).filter(Number.isFinite);
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  }
  return new Station(sim ? new SimulatedAir({ x, y }) : new MicTransport(), role, sim ? null : undefined);
}

/**
 * Simulated air needs no microphone, so the page starts listening by itself. Call it after
 * useStation: effects run in order, so the page is subscribed before the station says it started.
 */
export function useAutoStart(station: Station) {
  useEffect(() => {
    if (station.transport.kind === 'simulated') void station.start();
  }, [station]);
}
