import { useRef, useState, useEffect, type ReactNode } from 'react';
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
    setEl(panelRef.current);
  }, []);

  const enabled = !hidden && !!onPullRefresh;
  const { pull, refreshing, hint, show, spin, pullProgress } = useAppPullRefresh(el, onPullRefresh, enabled);
  const h = refreshing ? 52 : show ? Math.max(40, Math.min(56, pull * 0.65)) : 0;

  return (
    <div
      ref={panelRef}
      className={className ? `app-tab-panel ${className}` : 'app-tab-panel'}
      data-tab={tab}
      hidden={hidden || undefined}
    >
      {show && (
        <div
          className={`app-pull-refresh${refreshing ? ' active' : ''}${pullProgress >= 1 ? ' ready' : ''}`}
          style={{ height: h }}
          aria-live="polite"
          aria-busy={refreshing || undefined}
        >
          <span
            className={`app-pull-spinner${spin ? ' spin' : ''}`}
            style={refreshing ? undefined : { ['--pull' as string]: `${Math.round(pullProgress * 300)}deg` }}
            aria-hidden
          />
          {hint && <span className="app-pull-label">{hint}</span>}
        </div>
      )}
      {children}
    </div>
  );
}
