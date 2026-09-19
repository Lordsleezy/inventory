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

function paramPairs(err) {
  if (!Array.isArray(err?.parameters)) return [];
  return err.parameters
    .map((p) => {
      const name = decodeEbayText(p?.name ?? "").trim();
      const value = decodeEbayText(p?.value ?? "").trim();
      if (name && value) return `${name}=${value}`;
      return value || name;
    })
    .filter(Boolean);
}

function describeEbayError(err) {
  const kind = err?.kind || "error";
  const id = err?.errorId != null && err.errorId !== "" ? `errorId ${err.errorId}` : "";
  const short = decodeEbayText(err?.message || "").trim();
  const long = decodeEbayText(err?.longMessage || "").trim();
  const params = paramPairs(err);
  const refs = [...(err?.inputRefIds || []), ...(err?.outputRefIds || [])].map((r) => decodeEbayText(r)).filter(Boolean);
  const text = long && short && normalizeEbayText(long).includes(normalizeEbayText(short)) ? long : [short, long].filter(Boolean).join(" ");
  const core = expandBareInvalid(text || "eBay rejected this field");
  const extra = [
    id,
    kind === "warning" ? "warning" : "",
    params.length ? `parameters: ${params.join("; ")}` : "",
    refs.length ? `refs: ${refs.join(", ")}` : "",
    hintFor(`${text} ${params.join(" ")}`, params.join(" "), err?.errorId),
  ].filter(Boolean);
  return `${core}. ${extra.join(" | ")}`.replace(/\s+\./g, ".").replace(/\.\./g, ".").trim();
}

export function formatEbayError(json, fallback = "eBay rejected the listing.") {
  const errors = Array.isArray(json?.errors) ? json.errors.map((row) => ({ kind: "error", ...row })) : [];
  const warnings = Array.isArray(json?.warnings) ? json.warnings.map((row) => ({ kind: "warning", ...row })) : [];
  const rows = [...errors, ...warnings];
  let summary;
  if (!rows.length) {
    const raw = json?.error_description || json?.error || json?.message || json?.raw || fallback;
    summary = decodeEbayText(expandBareInvalid(String(raw || fallback)));
  } else {
    const seen = new Set();
    const lines = [];
    for (const row of rows) {
      const line = describeEbayError(row);
      const key = normalizeEbayText(line);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      lines.push(line);
    }
    summary = lines.join(" ");
  }
  const dump = json && typeof json === "object" ? JSON.stringify(json) : "";
  if (dump && dump !== "{}" && dump !== "null") {
    return `${summary} ebay_raw=${dump.slice(0, 8000)}`;
  }
  return summary;
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
  if (/25713|offer is not available/.test(blob)) {
    return "Fix: Floor will delete stale unpublished offers for this SKU and publish a new offer.";
  }
  if (/merchantlocation|location.?key|inventory location/.test(blob)) {
    return "Fix: Floor will recreate the warehouse location with an alphanumeric key.";
  }
  if (/\bcondition\b/.test(blob) && /invalid|required/.test(blob)) {
    return "Fix: Set condition on the unit to New, Open box, Excellent, Very good, Good, Fair, or For parts.";
  }
  if (/aspect|item specific|brand|mpn|manufacturer/.test(blob)) {
    return "Fix: Fill brand and model on the unit (and type/category if you have it).";
  }
  if (/weight|dimension|package|shipping package/.test(blob)) {
    return "Fix: Add width, height, and depth on the unit so eBay has package size for a large appliance.";
  }
  if (/category/.test(blob) && /invalid|required/.test(blob)) {
    return "Fix: Use a clearer brand/model/title so Floor can pick the right eBay category.";
  }
  if (/\bsku\b/.test(blob) && /invalid|exist|duplicate/.test(blob)) {
    return "Fix: Use the Floor SKU as-is; if eBay still rejects it, the SKU may already exist in this sandbox seller account.";
  }
  return "";
}

export function locationKey(storeId) {
  const id = String(storeId).replace(/-/g, "").slice(0, 16);
  return `flr${id}`;
}
