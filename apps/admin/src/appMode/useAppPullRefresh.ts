import { useEffect, useRef, useState } from 'react';

const THRESHOLD_PX = 64;
const MIN_SPIN_MS = 450;

export type PullRefreshHandler = () => void | Promise<void>;

function scrollerAtTop(root: HTMLElement, target: EventTarget | null) {
  if (root.scrollTop > 2) return false;
  let node = target instanceof Element ? target : null;
  while (node && root.contains(node)) {
    if (node instanceof HTMLElement && node !== root) {
      const scrollable = node.scrollHeight > node.clientHeight + 2;
      if (scrollable && node.scrollTop > 2) return false;
    }
    if (node === root) break;
    node = node.parentElement;
  }
  return true;
}

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
      if (!scrollerAtTop(panel, e.target)) {
        armed.current = false;
        return;
      }
      armed.current = true;
      startY.current = e.touches[0]?.clientY ?? 0;
    };

    const onMove = (e: TouchEvent) => {
      if (!armed.current || !scrollerAtTop(panel, e.target)) {
        setPull(0);
        return;
      }
      const y = e.touches[0]?.clientY ?? 0;
      const d = y - startY.current;
      if (d > 0) setPull(Math.min(96, d));
      else setPull(0);
    };

    const onEnd = (e: TouchEvent) => {
      const delta = (e.changedTouches[0]?.clientY ?? 0) - startY.current;
      if (!armed.current || busy.current) {
        armed.current = false;
        setPull(0);
        return;
      }
      armed.current = false;
      if (delta < THRESHOLD_PX || !scrollerAtTop(panel, e.target)) {
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

    const opts = { passive: true, capture: true } as const;
    panel.addEventListener('touchstart', onStart, opts);
    panel.addEventListener('touchmove', onMove, opts);
    panel.addEventListener('touchend', onEnd, opts);
    panel.addEventListener('touchcancel', onCancel, opts);
    return () => {
      panel.removeEventListener('touchstart', onStart, opts);
      panel.removeEventListener('touchmove', onMove, opts);
      panel.removeEventListener('touchend', onEnd, opts);
      panel.removeEventListener('touchcancel', onCancel, opts);
    };
  }, [panel, enabled, onRefresh]);

  const show = pull > 4 || refreshing;
  const hint = refreshing
    ? 'Refreshing'
    : pull >= THRESHOLD_PX
      ? 'Release to refresh'
      : pull > 4
        ? 'Pull to refresh'
        : '';
  const spin = refreshing || pull >= THRESHOLD_PX * 0.7;
  const pullProgress = Math.min(1, pull / THRESHOLD_PX);

  return { pull, refreshing, hint, threshold: THRESHOLD_PX, show, spin, pullProgress };
}
