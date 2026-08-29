/**
 * Entry point.
 *
 * `StrictMode` is deliberately NOT used. In development it double-invokes
 * effects, which would open two Colyseus connections and two prediction
 * reconcilers against the same room — the second one silently fighting the
 * first over the same input handle. The netcode is the one place where the
 * double-render check costs more than it catches.
 */

import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root missing from index.html');

createRoot(container).render(<App />);
