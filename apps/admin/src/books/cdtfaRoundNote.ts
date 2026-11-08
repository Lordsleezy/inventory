/** Dollar lines that are rounded on their own, plus the totals built from them. */
const COMPARE = ['1', '8', '10', 'B3', '12', '13', '14', '15', '17', '18', '26'];

export function roundingNote(
  quarter: { id: string; dollars: number }[],
  months: { id: string; dollars: number }[][],
): string | null {
  if (months.length < 2) return null;
  const at = (rows: { id: string; dollars: number }[], id: string) => rows.find((row) => row.id === id)?.dollars ?? 0;
  const gaps = COMPARE.flatMap((id) => {
    const summed = months.reduce((n, rows) => n + at(rows, id), 0);
    const together = at(quarter, id);
    return summed === together ? [] : [`line ${id} is ${money(together)} here and ${money(summed)} if you add the rounded forms`];
  });
  if (!gaps.length) return null;
  return `The cents were added first, then each line was rounded to the nearest dollar. ${gaps.join('; ')}. That difference is the rounding, not a second tax bill.`;
}

function money(n: number) {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
}
