import { useEffect, useRef, useState } from 'react';

const MIN_SPIN_MS = 450;

export type PullRefreshHandler = () => void | Promise<void>;

/** How far the screen has to travel before a pull counts. A quarter of the list. */
function quarter(panel: HTMLElement) {
  return Math.max(160, Math.round(panel.clientHeight * 0.25));
}

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

/** Pull the list down with the finger. Refresh only after it has moved a quarter of the screen. */
export function useAppPullRefresh(
  panel: HTMLElement | null,
  onRefresh: PullRefreshHandler | undefined,
  enabled: boolean,
) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [ready, setReady] = useState(false);
  const startY = useRef(0);
  const armed = useRef(false);
  const busy = useRef(false);
  const offsetRef = useRef(0);
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  useEffect(() => {
    if (!panel || !enabled || !onRefresh) {
      offsetRef.current = 0;
      setOffset(0);
      setDragging(false);
      setRefreshing(false);
      setReady(false);
      return;
    }

    const paint = (px: number) => {
      const next = Math.max(0, px);
      offsetRef.current = next;
      setOffset(next);
      setReady(next >= quarter(panel) - 1);
    };

    const onStart = (e: TouchEvent) => {
      if (busy.current || !scrollerAtTop(panel, e.target)) {
        armed.current = false;
        return;
      }
      armed.current = true;
      startY.current = e.touches[0]?.clientY ?? 0;
    };

    const onMove = (e: TouchEvent) => {
      if (!armed.current || busy.current) return;
      if (!scrollerAtTop(panel, e.target)) {
        armed.current = false;
        setDragging(false);
        paint(0);
        return;
      }
      const y = e.touches[0]?.clientY ?? 0;
      const d = y - startY.current;
      if (d <= 0) {
        setDragging(false);
        paint(0);
        return;
      }
      if (e.cancelable) e.preventDefault();
      const limit = quarter(panel);
      const travel = d <= limit ? d : limit + (d - limit) * 0.28;
      setDragging(true);
      paint(travel);
    };

    const onEnd = () => {
      if (!armed.current || busy.current) {
        armed.current = false;
        setDragging(false);
        if (!busy.current) paint(0);
        return;
      }
      armed.current = false;
      setDragging(false);
      const limit = quarter(panel);
      if (offsetRef.current < limit) {
        paint(0);
        return;
      }
      busy.current = true;
      setRefreshing(true);
      setReady(true);
      paint(limit);
      const started = performance.now();
      const close = () => {
        const wait = Math.max(0, MIN_SPIN_MS - (performance.now() - started));
        window.setTimeout(() => {
          busy.current = false;
          setRefreshing(false);
          setReady(false);
          paint(0);
        }, wait);
      };
      void Promise.resolve(onRefreshRef.current?.()).then(close, close);
    };

    const cap = { capture: true } as const;
    const passive = { ...cap, passive: true };
    const active = { ...cap, passive: false };
    panel.addEventListener('touchstart', onStart, passive);
    panel.addEventListener('touchmove', onMove, active);
    panel.addEventListener('touchend', onEnd, passive);
    panel.addEventListener('touchcancel', onEnd, passive);
    return () => {
      panel.removeEventListener('touchstart', onStart, passive);
      panel.removeEventListener('touchmove', onMove, active);
      panel.removeEventListener('touchend', onEnd, passive);
      panel.removeEventListener('touchcancel', onEnd, passive);
    };
  }, [panel, enabled, onRefresh]);

  const hint = refreshing ? 'Refreshing' : ready ? 'Release to refresh' : offset > 48 ? 'Pull to refresh' : '';
  const spin = refreshing || ready;
  return { offset, dragging, refreshing, hint, show: offset > 8 || refreshing, spin, ready };
}
