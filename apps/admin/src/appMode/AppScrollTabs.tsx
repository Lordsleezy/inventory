import { useEffect, useRef, type ReactNode } from 'react';

export type ScrollTabItem<T extends string> = { id: T; label: ReactNode };

export function AppScrollTabs<T extends string>({
  items,
  value,
  onChange,
  className,
  ariaLabel,
}: {
  items: ScrollTabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
  ariaLabel: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const selected = list.querySelector<HTMLElement>(`[data-tab-id="${value}"]`);
    if (!selected) return;
  const left = selected.offsetLeft - Math.max(0, (list.clientWidth - selected.clientWidth) / 2);
    list.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
  }, [value, items.length]);

  return (
    <div
      className={className ? `app-scroll-tabs ${className}` : 'app-scroll-tabs'}
      role="tablist"
      aria-label={ariaLabel}
      ref={listRef}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          data-tab-id={item.id}
          aria-selected={value === item.id}
          className={value === item.id ? 'on' : ''}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
