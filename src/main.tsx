import { render } from 'preact';
import { MicTransport, SimulatedAir } from './audio/transport';
import { Station } from './station';
import { App } from './ui/app';
import './ui/styles.css';

// ?air=sim swaps the microphone for a simulated room shared by every tab of this browser.
const sim = new URLSearchParams(location.search).get('air') === 'sim';
const station = new Station(sim ? new SimulatedAir() : new MicTransport(), 'phone', sim ? null : undefined);
if (sim) void station.start();

render(<App station={station} />, document.getElementById('app')!);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => undefined);
}
