import { moneyStringToCents, type Cents } from "@floor/domain";

export const IMPORT_FIELDS = [
  "sku",
  "brand",
  "model",
  "title",
  "category",
  "lot",
  "msrp",
  "retail",
  "retailer",
  "capturedOn",
  "acquisition",
  "condition",
  "ask",
  "floor",
  "mfrSerial",
  "location",
  "notes",
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number];
export type ColumnMap = Partial<Record<ImportField, string>>;

const GUESSES: Record<ImportField, string[]> = {
  sku: ["sku"],
  brand: ["brand"],
  model: ["model"],
  title: ["title", "description", "name"],
  category: ["category"],
  lot: ["lot", "batch"],
  msrp: ["msrp"],
  retail: ["retail_ref", "retail", "retail_price"],
  retailer: ["retail_ref_source", "retailer", "retail_source"],
  capturedOn: ["retail_ref_date", "retail_date", "captured_on"],
  acquisition: ["acquisition_cost", "acquisition", "cost"],
  condition: ["condition"],
  ask: ["ask_price", "ask"],
  floor: ["floor_price", "floor"],
  mfrSerial: ["serial", "mfr_serial", "manufacturer_serial"],
  location: ["location"],
  notes: ["notes"],
};

export function guessColumnMap(headers: string[]): ColumnMap {
  const lower = headers.map((h) => h.trim().toLowerCase());
  const map: ColumnMap = {};
  for (const field of IMPORT_FIELDS) {
    const hit = GUESSES[field].find((g) => lower.includes(g));
    if (hit) map[field] = headers[lower.indexOf(hit)];
  }
  return map;
}

export type ParsedImportRow = {
  line: number;
  sku: string | null;
  brand: string;
  model: string;
  title: string;
  category: string;
  lot: string | null;
  msrpCents: Cents | null;
  retailCents: Cents | null;
  retailer: string | null;
  capturedOn: string | null;
  acquisitionCostCents: Cents | null;
  condition: string | null;
  askCents: Cents | null;
  floorCents: Cents | null;
  mfrSerial: string | null;
  location: string | null;
  notes: string | null;
  error: string | null;
};

function cell(row: Record<string, string>, map: ColumnMap, field: ImportField): string {
  const header = map[field];
  if (!header) return "";
  return (row[header] ?? "").trim();
}

function money(raw: string, label: string): { value: Cents | null; error: string | null } {
  if (!raw) return { value: null, error: null };
  try {
    return { value: moneyStringToCents(raw), error: null };
  } catch {
    return { value: null, error: `${label} is not money: ${raw}` };
  }
}

export function parseImportRow(
  headers: string[],
  values: string[],
  map: ColumnMap,
  line: number,
): ParsedImportRow {
  const row: Record<string, string> = {};
  headers.forEach((h, i) => {
    row[h] = values[i] ?? "";
  });
  const errors: string[] = [];
  const skuRaw = cell(row, map, "sku");
  let sku: string | null = skuRaw || null;
  if (sku && !/^\d{5}$/.test(sku)) {
    errors.push(`SKU must be five digits, got ${sku}`);
    sku = skuRaw;
  }
  const msrp = money(cell(row, map, "msrp"), "msrp");
  const retail = money(cell(row, map, "retail"), "retail");
  const acquisition = money(cell(row, map, "acquisition"), "acquisition");
  const ask = money(cell(row, map, "ask"), "ask");
  const floor = money(cell(row, map, "floor"), "floor");
  for (const item of [msrp, retail, acquisition, ask, floor]) {
    if (item.error) errors.push(item.error);
  }
  const model = cell(row, map, "model");
  if (!model && !errors.length) errors.push("model is required");
  return {
    line,
    sku,
    brand: cell(row, map, "brand"),
    model,
    title: cell(row, map, "title"),
    category: cell(row, map, "category"),
    lot: cell(row, map, "lot") || null,
    msrpCents: msrp.value,
    retailCents: retail.value,
    retailer: cell(row, map, "retailer") || null,
    capturedOn: cell(row, map, "capturedOn") || null,
    acquisitionCostCents: acquisition.value,
    condition: cell(row, map, "condition") || null,
    askCents: ask.value,
    floorCents: floor.value,
    mfrSerial: cell(row, map, "mfrSerial") || null,
    location: cell(row, map, "location") || null,
    notes: cell(row, map, "notes") || null,
    error: errors.length ? errors.join("; ") : null,
  };
}
