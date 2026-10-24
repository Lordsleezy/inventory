export const CENSUS_QUARTERS_URL =
  "https://www.census.gov/retail/mrts/www/data/delimited/tsnadprectbl3.dat";

/** Census table 3: quarter / total retail / not-adjusted e-commerce / ... */
export function parseCensusQuarters(body) {
  return String(body || "").split(/\r?\n/).map((line) => {
    const fields = line.trim().split("/");
    const match = /^(\d)(?:st|nd|rd|th) quarter (\d{4})/.exec(fields[0] || "");
    if (!match) return null;
    const value = Number(fields[2]);
    if (!Number.isFinite(value) || value <= 0) return null;
    return {
      year: Number(match[2]), quarter: Number(match[1]),
      not_adjusted_millions: value, source_url: CENSUS_QUARTERS_URL,
      fetched_at: new Date().toISOString(),
    };
  }).filter(Boolean).slice(0, 24);
}

/** Multipliers centered on 1, using recent full years only. */
export function quarterSeasonalFactors(rows) {
  const years = new Map();
  for (const row of rows || []) {
    const quarters = years.get(row.year) || {};
    quarters[row.quarter] = Number(row.not_adjusted_millions);
    years.set(row.year, quarters);
  }
  const full = [...years.entries()].filter(([, quarters]) => [1, 2, 3, 4].every((q) => quarters[q] > 0))
    .sort((a, b) => b[0] - a[0]).slice(0, 5);
  if (!full.length) return [1, 1, 1, 1];
  return [1, 2, 3, 4].map((quarter) =>
    full.reduce((sum, [, quarters]) => {
      const average = (quarters[1] + quarters[2] + quarters[3] + quarters[4]) / 4;
      return sum + quarters[quarter] / average;
    }, 0) / full.length);
}
