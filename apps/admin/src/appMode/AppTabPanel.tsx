import { useRef, useState, useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useAppPullRefresh } from './useAppPullRefresh';

type Props = {
  tab: string;
  hidden?: boolean;
  className?: string;
  onPullRefresh?: () => void | Promise<void>;
  children: ReactNode;
};

export function AppTabPanel({ tab, hidden, className, onPullRefresh, children }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!hidden) setEl(panelRef.current);
  }, [hidden]);

  const enabled = !hidden && !!onPullRefresh;
  const { refreshing, hint, show, spin, pullProgress } = useAppPullRefresh(el, onPullRefresh, enabled);

  const overlay = show && typeof document !== 'undefined' ? createPortal(
    <div
      className={`app-pull-refresh-float${refreshing ? ' active' : ''}${pullProgress >= 1 ? ' ready' : ''}`}
      data-tab={tab}
      aria-live="polite"
      aria-busy={refreshing || undefined}
    >
      <span className={`app-pull-spinner${spin ? ' spin' : ''}`} aria-hidden />
      {hint && <span className="app-pull-label">{hint}</span>}
    </div>,
    document.body,
  ) : null;

  return (
    <div
      ref={panelRef}
      className={className ? `app-tab-panel ${className}` : 'app-tab-panel'}
      data-tab={tab}
      hidden={hidden || undefined}
    >
      {overlay}
      {children}
    </div>
  );
}
