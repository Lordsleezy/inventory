export type InventoryCategoryRow = {
  category: string;
  units: number;
  cost_cents: number;
  floor_cents: number;
  sold_units: number;
  sell_through: number;
};

/** Categories with a single unit are one-offs. The spreadsheet lists them as Other. */
export function rollupRareCategories(rows: InventoryCategoryRow[]): InventoryCategoryRow[] {
  const keep: InventoryCategoryRow[] = [];
  const other: InventoryCategoryRow = { category: 'Other', units: 0, cost_cents: 0, floor_cents: 0, sold_units: 0, sell_through: 0 };
  let folded = false;
  for (const row of rows) {
    const name = String(row.category || '').trim();
    const units = Number(row.units) || 0;
    if (!name || name.toLowerCase() === 'other' || units <= 1) {
      folded = true;
      other.units += units;
      other.cost_cents += Number(row.cost_cents) || 0;
      other.floor_cents += Number(row.floor_cents) || 0;
      other.sold_units += Number(row.sold_units) || 0;
    } else {
      keep.push(row);
    }
  }
  if (folded) {
    const denom = other.sold_units + other.units;
    other.sell_through = denom === 0 ? 0 : Math.round((1000 * other.sold_units) / denom) / 10;
    keep.push(other);
  }
  keep.sort((a, b) => b.cost_cents - a.cost_cents || a.category.localeCompare(b.category));
  return keep;
}
