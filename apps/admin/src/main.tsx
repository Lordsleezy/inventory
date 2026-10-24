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
    // New worker took control — reload only when it won't wipe an open receive form.
    reloadWhenSafe();
  });

  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').then((reg) => {
      const poke = () => { void reg.update().catch(() => undefined); };

      // Do NOT poke on every visibility/focus — returning from the camera would
      // discover a waiting SW and reload mid-entry. Quiet background check only.
      setInterval(poke, 5 * 60_000);

      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state !== 'installed') return;
          if (!navigator.serviceWorker.controller) return; // first install — no reload needed
          waitingWorker = sw;
          activateWaiting();
        });
      });

      if (reg.waiting) {
        waitingWorker = reg.waiting;
        activateWaiting();
      }

      // If a reload was deferred (or a worker is waiting), apply when inventoring is idle.
      setInterval(() => {
        if (waitingWorker) activateWaiting();
        if (pendingReload) reloadWhenSafe();
      }, 4_000);
    }).catch(() => {
      /* ignore — private mode / blocked SW */
    });
  });
}
