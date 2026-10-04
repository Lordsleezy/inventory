import { useEffect } from 'react';

const functionsBase = (import.meta.env.VITE_FLOOR_FUNCTIONS_URL || 'https://inventoryobi.netlify.app').replace(/\/$/, '');

export type ClientErrorInfo = { message: string; page?: string; status?: number | null; traceId?: string | null; sku?: string; action_name?: string };

/** Fire-and-forget: tell the backend about a failure the browser saw, so it shows up on the Logs page. */
export function reportClientError(token: string, info: ClientErrorInfo) {
  try {
    void fetch(`${functionsBase}/.netlify/functions/portal-logs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'client_error', url: location.href.split('#')[0], ...info }),
      keepalive: true,
    }).catch(() => undefined);
  } catch { /* reporting must never break the page */ }
}

/** Catches uncaught errors and unhandled promise failures anywhere in the portal. */
export function ClientErrorReporter({ token }: { token: string }) {
  useEffect(() => {
    const seen = new Set<string>();
    const send = (message: string) => {
      if (!message || seen.has(message) || seen.size >= 10) return;
      seen.add(message);
      reportClientError(token, { message, page: location.hash || 'portal' });
    };
    const onError = (e: ErrorEvent) => send(e.message || 'script error');
    const onRejection = (e: PromiseRejectionEvent) => send(e.reason instanceof Error ? e.reason.message : String(e.reason));
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => { window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onRejection); };
  }, [token]);
  return null;
}
