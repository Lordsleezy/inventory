export type LocationAllocation = { location_code: string; quantity: number };
export type LocationMovePlan = { from: string | null; to: string | null; quantity: number };

/** Spoken location. Codes stay `bay-row-bin`; a missing bin is the floor spot. */
export function locationPhrase(code?: string | null) {
  const [bay, row, bin] = String(code || '').split('-');
  if (!bay || !row || !Number.isFinite(Number(bay)) || !Number.isFinite(Number(row))) return code || '';
  if (!bin) return `Bay ${bay} · Row ${row} · Floor`;
  return `Bay ${bay} · Row ${row} · Bin ${bin}`;
}

export function unitsLabel(count: number) {
  const n = Math.max(0, Number(count) || 0);
  return `${n} unit${n === 1 ? '' : 's'}`;
}

/**
 * Put `quantity` into `target` by moving units that already sit in another bin
 * first, then taking the rest from unassigned stock. Never adds a second copy.
 */
export function planPlaceInBin(
  onHand: number,
  allocations: LocationAllocation[],
  target: string,
  quantity: number,
): LocationMovePlan[] {
  if (!target) throw new Error('Choose a bin.');
  if (!Number.isInteger(quantity) || quantity < 1) throw new Error('Enter how many are going into this bin.');
  const assigned = allocations.reduce((sum, row) => sum + row.quantity, 0);
  const loose = Math.max(0, onHand - assigned);
  const elsewhere = allocations.filter((row) => row.location_code !== target);
  const available = elsewhere.reduce((sum, row) => sum + row.quantity, 0) + loose;
  if (quantity > available) {
    const here = allocations.find((row) => row.location_code === target)?.quantity ?? 0;
    if (here > 0 && available === 0) throw new Error('Those units are already in this bin.');
    throw new Error('Not enough stock outside this bin.');
  }
  const moves: LocationMovePlan[] = [];
  let left = quantity;
  for (const row of elsewhere) {
    if (left <= 0) break;
    const take = Math.min(left, row.quantity);
    if (take > 0) {
      moves.push({ from: row.location_code, to: target, quantity: take });
      left -= take;
    }
  }
  if (left > 0) moves.push({ from: null, to: target, quantity: left });
  return moves;
}

/** Take `quantity` off the shelf. Sources are the bins that currently hold it. */
export function planUnassign(allocations: LocationAllocation[], quantity: number): LocationMovePlan[] {
  if (!Number.isInteger(quantity) || quantity < 1) throw new Error('Enter how many to unassign.');
  const assigned = allocations.reduce((sum, row) => sum + row.quantity, 0);
  if (assigned < 1) throw new Error('Nothing is assigned to a bin yet.');
  if (quantity > assigned) throw new Error('Not enough stock is in a bin.');
  const moves: LocationMovePlan[] = [];
  let left = quantity;
  for (const row of allocations) {
    if (left <= 0) break;
    const take = Math.min(left, row.quantity);
    if (take > 0) {
      moves.push({ from: row.location_code, to: null, quantity: take });
      left -= take;
    }
  }
  return moves;
}

/** A smaller layout is refused while a removed slot still holds units. */
export function layoutBlocked(
  bayNo: number,
  nextRows: number[],
  locations: { bay_no: number; row_no: number; bin_no: number | null; code: string; stock: number }[],
) {
  for (const loc of locations) {
    if (loc.bay_no !== bayNo || loc.stock <= 0) continue;
    const bins = nextRows[loc.row_no - 1];
    const held = unitsLabel(loc.stock);
    if (bins == null) return `Row ${loc.row_no} still has ${held}. Move them before removing the row.`;
    if (bins === 0 && loc.bin_no != null) return `Bin ${loc.code} still has ${held}. Move them before making this a floor row.`;
    if (bins > 0 && (loc.bin_no == null || loc.bin_no > bins)) return `Bin ${loc.code} still has ${held}. Move them before removing it.`;
  }
  return null;
}
