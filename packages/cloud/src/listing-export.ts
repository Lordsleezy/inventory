import { formatCents } from "@floor/store";

export type ExportUnit = {
  sku: string;
  brand: string;
  model: string;
  title: string;
  category: string | null;
  condition: string | null;
  testStatus: string | null;
  defectNotes: string | null;
  askCents: number | null;
  msrpCents: number | null;
  state: string;
  location: string | null;
};

export const EXPORT_COLUMNS = [
  "sku",
  "brand",
  "model",
  "title",
  "category",
  "condition",
  "test_status",
  "defect_notes",
  "ask_price",
  "msrp",
  "listed_on",
  "photo_folder",
  "photo_files",
  "listing_title",
  "listing_description",
] as const;

export function slugPart(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Folder like 11203-whirlpool-wrs325 */
export function photoFolderName(sku: string, brand: string, model: string): string {
  const parts = [slugPart(sku) || sku, slugPart(brand), slugPart(model)].filter(Boolean);
  return parts.join("-").slice(0, 80);
}

export function photoFileName(sku: string, indexFromOne: number): string {
  return `${sku}-${String(indexFromOne).padStart(2, "0")}.jpg`;
}

export function listingTitle(unit: ExportUnit): string {
  const name = [unit.brand, unit.model].filter((p) => String(p).trim()).join(" ").trim() || unit.title.trim() || `SKU ${unit.sku}`;
  const bits = [unit.condition, unit.category].filter((p) => p && String(p).trim());
  let title = name;
  if (bits.length) title += ` — ${bits.join(" · ")}`;
  title += ` | SKU ${unit.sku}`;
  return title;
}

export function listingDescription(unit: ExportUnit): string {
  const name = [unit.brand, unit.model].filter((p) => String(p).trim()).join(" ").trim();
  const lines: string[] = [];
  if (name) lines.push(name);
  if (unit.title.trim() && unit.title.trim() !== name) lines.push(unit.title.trim());
  lines.push("");
  if (unit.category) lines.push(`Category: ${unit.category}`);
  if (unit.condition) lines.push(`Condition: ${unit.condition}`);
  if (unit.testStatus) lines.push(`Test status: ${unit.testStatus}`);
  const ask = formatCents(unit.askCents);
  const msrp = formatCents(unit.msrpCents);
  if (ask) lines.push(`Ask: ${ask}`);
  if (msrp) lines.push(`MSRP: ${msrp}`);
  if (unit.location) lines.push(`Location: ${unit.location}`);
  lines.push(`SKU: ${unit.sku}`);
  const notes = (unit.defectNotes ?? "").trim();
  if (notes) {
    lines.push("");
    lines.push("Notes:");
    lines.push(notes);
  }
  lines.push("");
  lines.push("Sold as-is. Pickup in store unless arranged.");
  return lines.join("\n");
}

export function listedOnLabel(channels: string[]): string {
  const unique = [...new Set(channels.map((c) => c.trim()).filter((c) => c && c.toLowerCase() !== "floor"))];
  unique.sort((a, b) => a.localeCompare(b));
  return unique.join(", ");
}

export type SpreadsheetRow = Record<(typeof EXPORT_COLUMNS)[number], string>;

export function spreadsheetRow(input: {
  unit: ExportUnit;
  listedOn: string[];
  photoFolder: string;
  photoFiles: string[];
}): SpreadsheetRow {
  const { unit } = input;
  return {
    sku: unit.sku,
    brand: unit.brand,
    model: unit.model,
    title: unit.title,
    category: unit.category ?? "",
    condition: unit.condition ?? "",
    test_status: unit.testStatus ?? "",
    defect_notes: unit.defectNotes ?? "",
    ask_price: formatCents(unit.askCents),
    msrp: formatCents(unit.msrpCents),
    listed_on: listedOnLabel(input.listedOn),
    photo_folder: input.photoFiles.length ? input.photoFolder : "",
    photo_files: input.photoFiles.join("; "),
    listing_title: listingTitle(unit),
    listing_description: listingDescription(unit),
  };
}

export function csvEscape(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function toCsv(rows: SpreadsheetRow[]): string {
  const header = EXPORT_COLUMNS.join(",");
  const body = rows.map((row) => EXPORT_COLUMNS.map((col) => csvEscape(row[col])).join(","));
  return [header, ...body].join("\r\n") + "\r\n";
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function zipStore(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  const encoder = new TextEncoder();
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = file.data;
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    locals.push(local);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((n, p) => n + p.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let p = 0;
  for (const part of locals) {
    out.set(part, p);
    p += part.length;
  }
  for (const part of centrals) {
    out.set(part, p);
    p += part.length;
  }
  out.set(eocd, p);
  return out;
}

/** Minimal xlsx the user can open in Excel. Descriptions keep line breaks. */
export function toXlsx(rows: SpreadsheetRow[]): Uint8Array {
  const cell = (ref: string, text: string) =>
    `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`;
  const colLetter = (i: number) => {
    let n = i + 1;
    let s = "";
    while (n > 0) {
      const r = (n - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  };
  const sheetRows = [
    `<row r="1">${EXPORT_COLUMNS.map((col, i) => cell(`${colLetter(i)}1`, col)).join("")}</row>`,
  ];
  rows.forEach((row, r) => {
    const n = r + 2;
    sheetRows.push(
      `<row r="${n}">${EXPORT_COLUMNS.map((col, i) => cell(`${colLetter(i)}${n}`, row[col])).join("")}</row>`,
    );
  });
  const last = `${colLetter(EXPORT_COLUMNS.length - 1)}${rows.length + 1}`;
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${last}"/><sheetData>${sheetRows.join("")}</sheetData></worksheet>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="listings" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const ctypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;
  const enc = new TextEncoder();
  return zipStore([
    { name: "[Content_Types].xml", data: enc.encode(ctypes) },
    { name: "_rels/.rels", data: enc.encode(rootRels) },
    { name: "xl/workbook.xml", data: enc.encode(workbook) },
    { name: "xl/_rels/workbook.xml.rels", data: enc.encode(rels) },
    { name: "xl/worksheets/sheet1.xml", data: enc.encode(sheet) },
  ]);
}
