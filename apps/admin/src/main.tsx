import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './style.css';
import './appMode/appMode.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

/**
 * Store phone / home-screen PWA: when a new deploy installs a service worker,
 * claim clients and hard-reload so Receive and other screens pick up the build
 * without a manual force-close.
 */
if ('serviceWorker' in navigator) {
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    location.reload();
  });

  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').then((reg) => {
      const poke = () => { void reg.update().catch(() => undefined); };
      // Catch deploys while the app stays open on the counter.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') poke();
      });
      window.addEventListener('focus', poke);
      setInterval(poke, 60_000);

      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            sw.postMessage('SKIP_WAITING');
          }
        });
      });

      // Already waiting from a prior deploy — activate now.
      if (reg.waiting) reg.waiting.postMessage('SKIP_WAITING');
    }).catch(() => {
      /* ignore — private mode / blocked SW */
    });
  });
}

import './design/tools.css';
