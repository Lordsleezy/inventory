import { useLiveBuildMismatch } from './liveBuild';

/** Shown in the phone shell when the installed bundle is behind production. */
export function LiveBuildBanner() {
  const { appSha, liveSha, stale } = useLiveBuildMismatch();
  if (!stale || !liveSha) return null;
  return (
    <p className="app-flag warn floor-live-build-banner" role="status">
      This install is build <strong>{appSha}</strong> but the server is <strong>{liveSha}</strong>.
      {' '}Pull down didn&apos;t update yet — tap <strong>Restart app</strong> in Settings, or delete and re-add the home screen icon.
    </p>
  );
}
