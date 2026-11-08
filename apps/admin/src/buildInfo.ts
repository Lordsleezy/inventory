/** Injected at build time via Vite define (Netlify COMMIT_REF / BUILD_DATE). */
export const FLOOR_BUILD_SHA = import.meta.env.VITE_FLOOR_BUILD_SHA || 'dev';
export const FLOOR_BUILD_DATE = import.meta.env.VITE_FLOOR_BUILD_DATE || '';

export function floorBuildLabel(): string {
  const sha = FLOOR_BUILD_SHA.slice(0, 7);
  if (!FLOOR_BUILD_DATE) return `Build ${sha}`;
  const d = new Date(FLOOR_BUILD_DATE);
  if (Number.isNaN(d.getTime())) return `Build ${sha}`;
  const when = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' });
  return `Build ${sha} · ${when}`;
}
