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
 * Store phone PWA: apply new shell builds without yanking the associate mid-Receive.
 * Never hard-reload while a Receive form, modal, or focused field is active — that was
 * restarting the app every time they returned from the camera or a deploy landed.
 */
if ('serviceWorker' in navigator) {
  let refreshing = false;
  let pendingReload = false;
  let waitingWorker: ServiceWorker | null = null;

  function isBusyInventoring(): boolean {
    try {
      if (document.querySelector('.receive-modal')) return true;
      if (document.querySelector('.app-receive-form')) return true;
      if (document.querySelector('.receive-panel.receive-app')) return true;
      if (document.querySelector('.photoIdBusy, [data-photo-busy="1"]')) return true;
      const ae = document.activeElement;
      if (ae instanceof HTMLElement) {
        const tag = ae.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || ae.isContentEditable) return true;
      }
      return false;
    } catch {
      return true;
    }
  }

  function activateWaiting() {
    const w = waitingWorker || null;
    if (!w) return;
    if (isBusyInventoring()) return;
    waitingWorker = null;
    w.postMessage('SKIP_WAITING');
  }

  function reloadWhenSafe() {
    if (refreshing) return;
    if (isBusyInventoring() || document.visibilityState !== 'visible') {
      pendingReload = true;
      return;
    }
    refreshing = true;
    pendingReload = false;
    location.reload();
  }

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Keyboard hotfix: always reload once the new worker controls us. Losing an open
    // form once is better than leaving the phone on a Gboard-freezing shell.
    if (refreshing) return;
    refreshing = true;
    location.reload();
  });

  window.addEventListener('load', () => {
    try { document.documentElement.dataset.floorShell = 'v16'; } catch { /* ignore */ }
    void navigator.serviceWorker.register('/sw.js').then((reg) => {
      const poke = () => { void reg.update().catch(() => undefined); };

      poke();
      setInterval(poke, 30_000);

      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state !== 'installed') return;
          if (!navigator.serviceWorker.controller) return;
          waitingWorker = sw;
          // Hotfix: activate immediately.
          waitingWorker = null;
          sw.postMessage('SKIP_WAITING');
        });
      });

      if (reg.waiting) {
        reg.waiting.postMessage('SKIP_WAITING');
      }

      setInterval(() => {
        if (waitingWorker) activateWaiting();
        if (pendingReload) reloadWhenSafe();
      }, 4_000);
    }).catch(() => {
      /* ignore — private mode / blocked SW */
    });
  });
}
