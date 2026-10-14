import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AppProvider } from './state/AppContext';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('main: #root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </StrictMode>,
);

/**
 * Register the hand-written service worker (no workbox). It precaches the app
 * shell and serves it when the network is unavailable.
 */
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  globalThis.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      /* offline support is a bonus: the app still works without it */
    });
  });
}
