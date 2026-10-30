import { useEffect, useRef } from 'react';

/** Run page refreshes only while the page is visible, with a current callback. */
export function useVisibleInterval(callback: () => void, intervalMs: number, enabled = true, runImmediately = true) {
  const latest = useRef(callback);
  latest.current = callback;

  useEffect(() => {
    if (!enabled) return;
    let timer: number | null = null;
    let started = false;
    const start = () => {
      if (document.visibilityState !== 'visible' || timer !== null) return;
      if (runImmediately || started) latest.current();
      started = true;
      timer = window.setInterval(() => latest.current(), intervalMs);
    };
    const stop = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => document.visibilityState === 'visible' ? start() : stop();
    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [enabled, intervalMs, runImmediately]);
}
