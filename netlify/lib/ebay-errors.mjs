/** Turn eBay REST error JSON into a shop-floor sentence (never a bare "invalid"). */

export function decodeEbayText(value) {
  return String(value ?? "")
    .replace(/&apos;/gi, "'")
    .replace(/&#0*39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*34;/g, '"')
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function normalizeEbayText(value) {
  return decodeEbayText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function uniqueEbaySentences(parts) {
  const out = [];
  for (const raw of parts) {
    const text = decodeEbayText(raw).replace(/\s+/g, " ").trim();
    if (!text) continue;
    const key = normalizeEbayText(text);
    if (!key) continue;
    const idx = out.findIndex((existing) => {
      const other = normalizeEbayText(existing);
      return other === key || other.includes(key) || key.includes(other);
    });
    if (idx < 0) {
      out.push(text);
      continue;
    }
    if (text.length > out[idx].length) out[idx] = text;
  }
  return out.join(" ");
}

export function formatEbayError(json, fallback = "eBay rejected the listing.") {
  const errors = Array.isArray(json?.errors) ? json.errors : [];
  const warnings = Array.isArray(json?.warnings) ? json.warnings : [];
  const rows = errors.length ? errors : warnings;
  if (!rows.length) {
    const raw = json?.error_description || json?.error || json?.message || fallback;
    return uniqueEbaySentences([expandBareInvalid(String(raw || fallback))]);
  }
  return uniqueEbaySentences(rows.map(describeEbayError));
}

function describeEbayError(err) {
  const params = Array.isArray(err?.parameters)
    ? err.parameters
        .map((p) => {
          const name = String(p?.name ?? "").trim();
          const value = String(p?.value ?? "").trim();
          if (name && value && name !== value) return `${name}: ${value}`;
          return value || name;
        })
        .filter(Boolean)
        .join(", ")
    : "";
  const long = decodeEbayText(err?.longMessage || "").trim();
  const short = decodeEbayText(err?.message || "").trim();
  const text = long && short && normalizeEbayText(long).includes(normalizeEbayText(short)) ? long : long || short;
  const hint = hintFor(text, params, err?.errorId);
  const core = expandBareInvalid(text || "eBay rejected this field");
  const field = params ? ` Field: ${params}.` : "";
  const how = hint ? ` ${hint}` : "";
  return uniqueEbaySentences([`${core}.${field}${how}`.replace(/\.\./g, ".").trim()]);
}

function expandBareInvalid(text) {
  const t = decodeEbayText(text).trim();
  if (!t || /^invalid\.?$/i.test(t) || /^invalid data\.?$/i.test(t)) {
    return "eBay rejected the listing as invalid";
  }
  if (/a user error has occurred\.?\s*invalid data/i.test(t)) {
    return "eBay rejected one of the listing fields";
  }
  return t.replace(/\.$/, "");
}

function hintFor(text, params, errorId) {
  const blob = `${text} ${params} ${errorId}`.toLowerCase();
  if (/image|photo|picture/.test(blob)) {
    return "Fix: Floor must send photos as public HTTPS URLs eBay can download (not private signed links).";
  }
  if (/merchantlocation|location.?key|inventory location/.test(blob)) {
    return "Fix: Floor will recreate the warehouse location with an alphanumeric key.";
  }
  if (/condition/.test(blob)) {
    return "Fix: Set condition on the unit to New, Open box, Excellent, Very good, Good, Fair, or For parts.";
  }
  if (/aspect|item specific|brand|mpn|manufacturer/.test(blob)) {
    return "Fix: Fill brand and model on the unit (and type/category if you have it).";
  }
  if (/weight|dimension|package|shipping package/.test(blob)) {
    return "Fix: Add width, height, and depth on the unit so eBay has package size for a large appliance.";
  }
  if (/category/.test(blob)) {
    return "Fix: Use a clearer brand/model/title so Floor can pick the right eBay category.";
  }
  if (/sku/.test(blob)) {
    return "Fix: Use the Floor SKU as-is; if eBay still rejects it, the SKU may already exist in this sandbox seller account.";
  }
  return "";
}

export function locationKey(storeId) {
  const id = String(storeId).replace(/-/g, "").slice(0, 16);
  return `flr${id}`;
}
