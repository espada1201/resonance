import { render } from 'preact';
import { boot } from './boot';
import { App } from './ui/app';
import './ui/styles/index.css';

render(<App station={boot('phone')} />, document.getElementById('app')!);
