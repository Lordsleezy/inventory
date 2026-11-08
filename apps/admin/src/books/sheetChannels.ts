const LIVE_CHANNELS = new Set(['ebay', 'depop', 'tiktok', 'amazon', 'website']);

export function liveListedChannels<T extends { channel: string }>(rows: T[]): T[] {
  return rows.filter((row) => LIVE_CHANNELS.has(String(row.channel || '').toLowerCase()));
}

export function notListedLines(
  rows: { units: number; cost_cents: number }[],
  defective?: { units?: number; cost_cents?: number } | null,
) {
  const units = rows.reduce((n, row) => n + (Number(row.units) || 0), 0);
  const cost = rows.reduce((n, row) => n + (Number(row.cost_cents) || 0), 0);
  return {
    units,
    cost_cents: cost,
    defective_units: Number(defective?.units) || 0,
    defective_cost_cents: Number(defective?.cost_cents) || 0,
  };
}
