/** Ask for the latest sw.js and reload once when a waiting worker takes over. */
export function registerFloorServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        void reg.update();
        reg.addEventListener('updatefound', () => {
          const worker = reg.installing;
          if (!worker) return;
          worker.addEventListener('statechange', () => {
            if (worker.state !== 'installed') return;
            if (!navigator.serviceWorker.controller) return;
            worker.postMessage({ type: 'SKIP_WAITING' });
          });
        });
      })
      .catch(() => {
        /* private mode / blocked SW */
      });

    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    });
  });
}
