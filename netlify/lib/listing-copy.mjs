export function parseListingSpecs(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "string") {
    try {
      return parseListingSpecs(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  if (typeof raw !== "object") return null;
  return raw;
}

function sizeLine(specs) {
  if (!specs) return "";
  const bits = [specs.width_in, specs.height_in, specs.depth_in].filter((p) => p && String(p).trim());
  if (bits.length === 3) return `${bits[0]} W × ${bits[1]} H × ${bits[2]} D`;
  return "";
}

function capacityLine(specs) {
  if (!specs?.capacity_cu_ft) return "";
  const split = [specs.fridge_cu_ft && `${specs.fridge_cu_ft} fridge`, specs.freezer_cu_ft && `${specs.freezer_cu_ft} freezer`]
    .filter(Boolean)
    .join(" / ");
  return split ? `${specs.capacity_cu_ft} cu ft (${split})` : `${specs.capacity_cu_ft} cu ft`;
}

/** Phrases that steer buyers off eBay (Seller Hub "outside eBay" policy). */
export function stripOffPlatformContact(text) {
  return String(text || "")
    .replace(
      /\n*Message us on Depop if you need more detail before buying\.\s*If the item is not as described, reach out and we will make it right\.\s*/gi,
      "\n",
    )
    .replace(/\n*Message us on (Depop|Mercari|Facebook|Whatnot|Poshmark|Amazon)\b[^\n]*/gi, "\n")
    .replace(/\n+/g, "\n")
    .trim();
}

export function composeChannelDescription(input) {
  const body = stripOffPlatformContact(String(input.listingBody || "").trim());
  const parts = [];
  if (body) parts.push(body);
  else {
    const name = [input.brand, input.model].filter((p) => String(p || "").trim()).join(" ").trim();
    if (name) parts.push(name);
    if (String(input.title || "").trim() && String(input.title).trim() !== name) parts.push(String(input.title).trim());
    const specLines = [];
    const cap = capacityLine(input.specs);
    const size = sizeLine(input.specs);
    if (input.specs?.configuration) specLines.push(input.specs.configuration);
    if (cap) specLines.push(cap);
    if (size) specLines.push(size);
    if (input.specs?.finish) specLines.push(input.specs.finish);
    if (specLines.length) parts.push(specLines.join(". ") + ".");
  }
  const notes = String(input.defectNotes || "").trim();
  parts.push("");
  parts.push("This unit (Floor):");
  parts.push(`Condition: ${String(input.condition || "").trim() || "not recorded"}`);
  parts.push(`Test status: ${String(input.testStatus || "").trim() || "not recorded"}`);
  parts.push(notes ? `Defects / notes: ${notes}` : "Defects / notes: none recorded");
  if (input.sku) parts.push(`SKU ${input.sku}`);
  parts.push("Sold as-is. Local pickup unless arranged.");
  return parts.join("\n").trim();
}
