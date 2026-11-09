import { useCallback, useRef } from 'react';

/** Bump state and return a promise that settles when onReady() is called (pull-to-refresh). */
export function useAwaitableRefresh(bump: () => void) {
  const waiter = useRef<(() => void) | null>(null);

  const pull = useCallback(() => new Promise<void>((resolve) => {
    waiter.current = resolve;
    bump();
  }), [bump]);

  const ready = useCallback(() => {
    waiter.current?.();
    waiter.current = null;
  }, []);

  return { pull, ready };
}
