export const PIN_MAX_FAILURES = 5;
export const PIN_LOCK_MINUTES = 5;

export function nextPinState(failedCount: number, correct: boolean, nowMs: number) {
  if (correct) {
    return { failedCount: 0, lockedUntilMs: null as number | null };
  }
  const next = failedCount + 1;
  return {
    failedCount: next,
    lockedUntilMs: next >= PIN_MAX_FAILURES ? nowMs + PIN_LOCK_MINUTES * 60_000 : null,
  };
}

export function pinIsLocked(lockedUntilMs: number | null, nowMs: number): boolean {
  return lockedUntilMs != null && lockedUntilMs > nowMs;
}
