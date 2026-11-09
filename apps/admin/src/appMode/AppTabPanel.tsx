import { useRef, useState, useEffect, type ReactNode } from 'react';
import { useAppPullRefresh } from './useAppPullRefresh';

type Props = {
  tab: string;
  hidden?: boolean;
  className?: string;
  onPullRefresh?: () => void;
  children: ReactNode;
};

export function AppTabPanel({ tab, hidden, className, onPullRefresh, children }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    setEl(panelRef.current);
  }, []);

  const enabled = !hidden && !!onPullRefresh;
  const { pull, refreshing, hint, threshold } = useAppPullRefresh(el, onPullRefresh, enabled);
  const spacer = refreshing ? 36 : pull > 0 ? Math.min(pull, 56) : 0;

  return (
    <div
      ref={panelRef}
      className={className ? `app-tab-panel ${className}` : 'app-tab-panel'}
      data-tab={tab}
      hidden={hidden || undefined}
    >
      {(spacer > 0 || hint) && (
        <div
          className={`app-pull-refresh${refreshing ? ' active' : ''}${pull >= threshold ? ' ready' : ''}`}
          style={{ height: spacer || undefined }}
          aria-live="polite"
        >
          {hint}
        </div>
      )}
      {children}
    </div>
  );
}
