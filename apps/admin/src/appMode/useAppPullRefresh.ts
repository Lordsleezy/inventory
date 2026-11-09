import { useEffect, useRef, useState } from 'react';

const THRESHOLD_PX = 72;

/** Pull down at scroll top to refresh (mobile app tabs). */
export function useAppPullRefresh(
  panel: HTMLElement | null,
  onRefresh: (() => void) | undefined,
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
      setPull(Math.max(0, Math.min(96, y - startY.current)));
    };

    const onEnd = (e: TouchEvent) => {
      const delta = (e.changedTouches[0]?.clientY ?? 0) - startY.current;
      setPull(0);
      if (!armed.current || panel.scrollTop > 2 || busy.current) {
        armed.current = false;
        return;
      }
      armed.current = false;
      if (delta < THRESHOLD_PX) return;
      busy.current = true;
      setRefreshing(true);
      onRefreshRef.current?.();
      window.setTimeout(() => {
        busy.current = false;
        setRefreshing(false);
      }, 700);
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

  const hint = refreshing
    ? 'Refreshing…'
    : pull >= THRESHOLD_PX
      ? 'Release to refresh'
      : pull > 16
        ? 'Pull to refresh'
        : '';

  return { pull, refreshing, hint, threshold: THRESHOLD_PX };
}
