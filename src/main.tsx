import { render } from 'preact';
import { boot } from './boot';
import { App } from './ui/app';
import './ui/styles.css';

const station = boot('phone');
if (station.transport.kind === 'simulated') void station.start();

render(<App station={station} />, document.getElementById('app')!);
