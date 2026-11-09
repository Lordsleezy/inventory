import { useCallback, useRef, useState, useEffect, type ReactNode } from 'react';
import { useAppPullRefresh } from './useAppPullRefresh';

type Props = {
  tab: string;
  hidden?: boolean;
  className?: string;
  onPullRefresh?: () => void | Promise<void>;
  children: ReactNode;
};

export function AppTabPanel({ tab, hidden, className, onPullRefresh, children }: Props) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const panelRefCb = useCallback((node: HTMLDivElement | null) => {
    panelRef.current = node;
    setEl(!hidden && node ? node : null);
  }, [hidden]);
  useEffect(() => {
    if (hidden) setEl(null);
    else if (panelRef.current) setEl(panelRef.current);
  }, [hidden]);

  const enabled = !hidden && !!onPullRefresh;
  const { offset, dragging, refreshing, hint, show, spin, ready } = useAppPullRefresh(el, onPullRefresh, enabled);
  const gap = show ? offset : 0;

  return (
    <div
      ref={panelRefCb}
      className={className ? `app-tab-panel ${className}` : 'app-tab-panel'}
      data-tab={tab}
      hidden={hidden || undefined}
    >
      {show && (
        <div
          className={`app-pull-indicator${ready || refreshing ? ' ready' : ''}`}
          style={{ height: gap }}
          data-tab={tab}
          aria-live="polite"
          aria-busy={refreshing || undefined}
        >
          <span className={`app-pull-spinner${spin ? ' spin' : ''}`} aria-hidden />
          {hint ? <span className="app-pull-label">{hint}</span> : null}
        </div>
      )}
      <div
        className={`app-pull-sheet${dragging ? ' is-dragging' : ''}`}
        style={{ transform: gap ? `translateY(${gap}px)` : undefined }}
      >
        {children}
      </div>
    </div>
  );
}
