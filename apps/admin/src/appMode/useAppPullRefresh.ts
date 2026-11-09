import { useEffect, useRef, useState } from 'react';

const THRESHOLD_PX = 72;
const MIN_SPIN_MS = 450;

export type PullRefreshHandler = () => void | Promise<void>;

/** Pull down at scroll top to refresh (mobile app tabs). */
export function useAppPullRefresh(
  panel: HTMLElement | null,
  onRefresh: PullRefreshHandler | undefined,
  enabled: boolean,
) {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef(0);
  const armed = useRef(false);
  const busy = useRef(false);
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  useEffect(() => {
    if (!panel || !enabled || !onRefresh) {
      setPull(0);
      setRefreshing(false);
      return;
    }

    const onStart = (e: TouchEvent) => {
      if (panel.scrollTop > 2) {
        armed.current = false;
        return;
      }
      armed.current = true;
      startY.current = e.touches[0]?.clientY ?? 0;
    };

    const onMove = (e: TouchEvent) => {
      if (!armed.current || panel.scrollTop > 2) {
        setPull(0);
        return;
      }
      const y = e.touches[0]?.clientY ?? 0;
      setPull(Math.max(0, Math.min(88, y - startY.current)));
    };

    const onEnd = (e: TouchEvent) => {
      const delta = (e.changedTouches[0]?.clientY ?? 0) - startY.current;
      if (!armed.current || panel.scrollTop > 2 || busy.current) {
        armed.current = false;
        setPull(0);
        return;
      }
      armed.current = false;
      if (delta < THRESHOLD_PX) {
        setPull(0);
        return;
      }
      busy.current = true;
      setRefreshing(true);
      setPull(0);
      const started = performance.now();
      const settle = () => {
        const wait = Math.max(0, MIN_SPIN_MS - (performance.now() - started));
        window.setTimeout(() => {
          busy.current = false;
          setRefreshing(false);
        }, wait);
      };
      void Promise.resolve(onRefreshRef.current?.()).then(settle, settle);
    };

    const onCancel = () => {
      armed.current = false;
      setPull(0);
    };

    panel.addEventListener('touchstart', onStart, { passive: true });
    panel.addEventListener('touchmove', onMove, { passive: true });
    panel.addEventListener('touchend', onEnd, { passive: true });
    panel.addEventListener('touchcancel', onCancel, { passive: true });
    return () => {
      panel.removeEventListener('touchstart', onStart);
      panel.removeEventListener('touchmove', onMove);
      panel.removeEventListener('touchend', onEnd);
      panel.removeEventListener('touchcancel', onCancel);
    };
  }, [panel, enabled, onRefresh]);

  const show = pull > 6 || refreshing;
  const hint = refreshing
    ? 'Refreshing'
    : pull >= THRESHOLD_PX
      ? 'Release to refresh'
      : pull > 6
        ? 'Pull to refresh'
        : '';

  const spin = refreshing || pull >= THRESHOLD_PX * 0.85;
  const pullProgress = Math.min(1, pull / THRESHOLD_PX);

  return { pull, refreshing, hint, threshold: THRESHOLD_PX, show, spin, pullProgress };
}
