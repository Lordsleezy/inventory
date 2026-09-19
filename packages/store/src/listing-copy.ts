export type ListingSpecs = {
  matched_model?: string | null;
  height_in?: string | null;
  width_in?: string | null;
  depth_in?: string | null;
  depth_without_handles_in?: string | null;
  depth_without_doors_in?: string | null;
  capacity_cu_ft?: number | null;
  fridge_cu_ft?: number | null;
  freezer_cu_ft?: number | null;
  configuration?: string | null;
  finish?: string | null;
  ice_maker?: string | null;
  water_dispenser?: string | null;
  energy?: string | null;
  features?: string[] | null;
  catalog_msrp?: string | null;
  installation?: string | null;
  voltage?: string | null;
  weight_lb?: number | string | null;
  ebay_aspects?: Record<string, string> | null;
};

export function specInchesValue(raw: unknown): string {
  const n = parseFloat(String(raw ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? String(n) : "";
}

export function parseListingSpecs(raw: unknown): ListingSpecs | null {
  if (raw == null || raw === "") return null;
  if (typeof raw === "string") {
    try {
      return parseListingSpecs(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  if (typeof raw !== "object") return null;
  return raw as ListingSpecs;
}

export function sizeLine(specs: ListingSpecs | null | undefined): string {
  if (!specs) return "";
  const bits = [specs.width_in, specs.height_in, specs.depth_in].filter((p) => p && String(p).trim());
  if (bits.length === 3) return `${bits[0]} W × ${bits[1]} H × ${bits[2]} D`;
  return "";
}

export function capacityLine(specs: ListingSpecs | null | undefined): string {
  if (!specs?.capacity_cu_ft) return "";
  const split = [specs.fridge_cu_ft && `${specs.fridge_cu_ft} fridge`, specs.freezer_cu_ft && `${specs.freezer_cu_ft} freezer`]
    .filter(Boolean)
    .join(" / ");
  return split ? `${specs.capacity_cu_ft} cu ft (${split})` : `${specs.capacity_cu_ft} cu ft`;
}

export function floorFacts(input: {
  condition?: string | null;
  testStatus?: string | null;
  defectNotes?: string | null;
  sku?: string;
}): string {
  const lines = ["This unit (Floor):"];
  lines.push(`Condition: ${(input.condition || "").trim() || "not recorded"}`);
  lines.push(`Test status: ${(input.testStatus || "").trim() || "not recorded"}`);
  const notes = (input.defectNotes || "").trim();
  lines.push(notes ? `Defects / notes: ${notes}` : "Defects / notes: none recorded");
  if (input.sku) lines.push(`SKU ${input.sku}`);
  lines.push("Sold as-is. Local pickup unless arranged.");
  return lines.join("\n");
}

/** Rebuild scannable product copy from structured specs. Does not touch Floor notes. */
export function regenerateListingBody(input: {
  brand?: string | null;
  model?: string | null;
  specs?: ListingSpecs | null;
}): string {
  const specs = input.specs;
  const matched = (specs?.matched_model || input.model || "").trim();
  const name = [input.brand, matched].filter((p) => String(p || "").trim()).join(" ").trim() || "This appliance";
  const lead: string[] = [];
  if (specs?.configuration) lead.push(specs.configuration);
  const cap = capacityLine(specs);
  if (cap) lead.push(cap);
  const size = sizeLine(specs);
  if (size) lead.push(size);
  const first = lead.length ? `${name} — ${lead.join("; ")}.` : `${name}.`;
  const rest: string[] = [];
  if (specs?.finish) rest.push(`Finish: ${specs.finish}.`);
  if (specs?.ice_maker) rest.push(`Ice maker: ${specs.ice_maker}.`);
  if (specs?.water_dispenser) rest.push(`Water: ${specs.water_dispenser}.`);
  if (specs?.energy) rest.push(`Energy: ${specs.energy}.`);
  if (specs?.depth_without_handles_in || specs?.depth_without_doors_in) {
    const d = [];
    if (specs.depth_without_handles_in) d.push(`${specs.depth_without_handles_in} deep without handles`);
    if (specs.depth_without_doors_in) d.push(`${specs.depth_without_doors_in} cabinet depth without doors`);
    rest.push(d.join("; ") + ".");
  }
  if (specs?.features?.length) rest.push(specs.features.join(". ") + ".");
  if (specs?.catalog_msrp) rest.push(`Typical new retail when we looked it up: ${specs.catalog_msrp}.`);
  return [first, rest.join(" ")].filter((p) => p.trim()).join(" ");
}

/** Product copy first; Floor condition/test/defects always last, never softened. */
export function composeChannelDescription(input: {
  listingBody?: string | null;
  brand?: string | null;
  model?: string | null;
  title?: string | null;
  specs?: ListingSpecs | null;
  condition?: string | null;
  testStatus?: string | null;
  defectNotes?: string | null;
  sku?: string;
}): string {
  const body = (input.listingBody || "").trim();
  const parts: string[] = [];
  if (body) parts.push(body);
  else {
    const name = [input.brand, input.model].filter((p) => String(p || "").trim()).join(" ").trim();
    if (name) parts.push(name);
    if (input.title?.trim() && input.title.trim() !== name) parts.push(input.title.trim());
    const specLines: string[] = [];
    const cap = capacityLine(input.specs);
    const size = sizeLine(input.specs);
    if (input.specs?.configuration) specLines.push(input.specs.configuration);
    if (cap) specLines.push(cap);
    if (size) specLines.push(size);
    if (input.specs?.finish) specLines.push(input.specs.finish);
    if (specLines.length) parts.push(specLines.join(". ") + ".");
  }
  parts.push("");
  parts.push(floorFacts(input));
  return parts.join("\n").trim();
}
