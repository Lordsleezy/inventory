import { useEffect, useState } from 'react';
import { FLOOR_BUILD_SHA } from './buildInfo';

const APP_SHORT = FLOOR_BUILD_SHA.slice(0, 7);

/** Compare baked bundle SHA to /build.json (no-cache) — catches stale PWA shells. */
export function useLiveBuildMismatch(): { appSha: string; liveSha: string | null; stale: boolean } {
  const [liveSha, setLiveSha] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void fetch('/build.json', { cache: 'no-store', headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (!alive || !body?.sha) return;
        setLiveSha(String(body.sha).slice(0, 7));
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, []);
  const stale = Boolean(liveSha && liveSha !== APP_SHORT && APP_SHORT !== 'dev');
  return { appSha: APP_SHORT, liveSha, stale };
}
