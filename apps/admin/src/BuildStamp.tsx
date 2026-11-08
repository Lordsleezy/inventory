import { floorBuildLabel } from './buildInfo';

export function BuildStamp({ className = '' }: { className?: string }) {
  return <p className={`floor-build-stamp${className ? ` ${className}` : ''}`} aria-label="App build version">{floorBuildLabel()}</p>;
}
