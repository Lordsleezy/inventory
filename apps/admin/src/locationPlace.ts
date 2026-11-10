export type LocationAllocation = { location_code: string; quantity: number };
export type LocationMovePlan = { from: string | null; to: string | null; quantity: number };

/** Spoken location. Codes stay `bay-row-bin`; a missing bin is the floor spot. */
export function locationPhrase(code?: string | null) {
  const [bay, row, bin] = String(code || '').split('-');
  if (!bay || !row || !Number.isFinite(Number(bay)) || !Number.isFinite(Number(row))) return code || '';
  if (!bin) return `Bay ${bay} · Row ${row} · Floor`;
  return `Bay ${bay} · Row ${row} · Bin ${bin}`;
}

export type LocationChoice = {
  code: string;
  bay_no?: number;
  row_no?: number;
  bin_no?: number | null;
  bay_name?: string | null;
};

/** A named bay keeps its name. Numbered bays stay "Bay 4". */
export function bayTitle(bayNo: number, name?: string | null) {
  const trimmed = (name || '').trim();
  return trimmed || `Bay ${bayNo}`;
}

/** Menu text. A named floor spot is just the name. */
export function locationMenuLabel(loc: LocationChoice): string {
  const name = loc.bay_name?.trim();
  const row = loc.row_no;
  const bin = loc.bin_no;
  if (name && row === 1 && bin == null) return name;
  if (name && row != null) {
    if (bin == null) return `${name} · Row ${row} · Floor`;
    return `${name} · R${row}-B${bin}`;
  }
  if (loc.bay_no != null && row != null) {
    return `Bay ${loc.bay_no} · R${row}${bin == null ? '' : `-B${bin}`}`;
  }
  return locationPhrase(loc.code) || loc.code;
}

/** Named areas first, then walking order. */
export function sortLocationChoices<T extends LocationChoice>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const named = Number(Boolean(b.bay_name?.trim())) - Number(Boolean(a.bay_name?.trim()));
    if (named) return named;
    const left = a.code.split('-').map(Number);
    const right = b.code.split('-').map(Number);
    for (let i = 0; i < 3; i += 1) {
      const diff = (left[i] || 0) - (right[i] || 0);
      if (diff) return diff;
    }
    return 0;
  });
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

/** Split a typed or pasted list into unique SKUs, keeping the first spelling. */
export function parseBulkSkus(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    const sku = part.trim();
    if (!sku) continue;
    const key = sku.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(sku);
  }
  return out;
}

export function addBulkSkus(existing: string[], raw: string): string[] {
  const seen = new Set(existing.map((sku) => sku.toLowerCase()));
  const next = [...existing];
  for (const sku of parseBulkSkus(raw)) {
    const key = sku.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(sku);
  }
  return next;
}

/** Location code for a chosen bay, row, and bin. A floor row has no bin number. */
export function slotTagCode(bayNo: number, rowNo: number, binCount: number, binNo: number | null): string {
  if (!Number.isInteger(bayNo) || bayNo < 1) throw new Error('Choose a bay.');
  if (!Number.isInteger(rowNo) || rowNo < 1) throw new Error('Choose a row.');
  if (binCount === 0) return `${bayNo}-${rowNo}`;
  if (binNo == null || !Number.isInteger(binNo) || binNo < 1 || binNo > binCount) throw new Error('Choose a bin.');
  return `${bayNo}-${rowNo}-${binNo}`;
}

/** First slot in the bay. A floor row has no bins, so the code is bay-row. */
export function bayTagCode(bayNo: number, rowBins: number[]): string {
  if (!rowBins.length) throw new Error('That bay has no rows.');
  const bins = rowBins[0];
  return slotTagCode(bayNo, 1, bins, bins === 0 ? null : 1);
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
