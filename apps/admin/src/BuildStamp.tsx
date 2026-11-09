import { floorBuildLabel } from './buildInfo';
import { useLiveBuildMismatch } from './liveBuild';

export function BuildStamp({ className = '' }: { className?: string }) {
  const { liveSha, stale } = useLiveBuildMismatch();
  return (
    <p className={`floor-build-stamp${className ? ` ${className}` : ''}`} aria-label="App build version">
      {floorBuildLabel()}
      {liveSha ? ` · server ${liveSha}${stale ? ' (update pending)' : ''}` : ''}
    </p>
  );
}
