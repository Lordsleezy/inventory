/** Drop a repeat of the same code inside the window so a held trigger cannot double-submit. */
export function shouldQueueScan(code: string, last: { code: string; at: number } | null, now: number, windowMs = 2000): boolean {
  const trimmed = code.trim();
  if (!trimmed) return false;
  if (last && last.code === trimmed && now - last.at < windowMs) return false;
  return true;
}
