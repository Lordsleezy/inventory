/** One short line for UI — never dump raw API / XML walls. */
export function shortError(err: unknown, fallback = 'Something went wrong'): string {
  let raw = '';
  if (typeof err === 'string') raw = err;
  else if (err instanceof Error) raw = err.message;
  else if (err && typeof err === 'object' && 'message' in err) raw = String((err as { message: unknown }).message);
  else raw = fallback;
  raw = raw.replace(/\s+/g, ' ').trim();
  if (/OutputSelector|CustomLabel/i.test(raw)) return 'eBay listing sync failed — retry pull to refresh';
  if (/fetch failed|Failed to fetch|NetworkError|ECONNRESET|ETIMEDOUT/i.test(raw)) return 'Couldn’t reach the server — check connection and retry';
  if (/Ack.?=.?Failure|ErrorCode|xmlns:|<\/?\w+/i.test(raw)) return 'Marketplace request failed — try again';
  if (raw.length > 120) return `${raw.slice(0, 110).trim()}…`;
  return raw || fallback;
}
