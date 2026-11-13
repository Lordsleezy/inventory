/** Store category list from portal_receive_options / staff_receive_options. */

export function categoryChoices(value) {
  const list = Array.isArray(value) ? value : [];
  return [...new Set(list.map((item) => String(item ?? "").trim()).filter(Boolean))];
}

/**
 * Options for the receive category field.
 * An empty field, or a value that already is a store category, shows the whole list.
 * Any other typing keeps the names that contain those letters.
 */
export function filterCategoryOptions(list, query) {
  const options = categoryChoices(list);
  const q = String(query ?? "").trim().toLowerCase();
  if (!q || options.some((name) => name.toLowerCase() === q)) return options;
  return options.filter((name) => name.toLowerCase().includes(q));
}

/** A pad, topper, or protector. An actual mattress does not match. */
export function isMattressAccessory(text) {
  return /\bmattress\s+(?:pads?|toppers?|protectors?)\b/i.test(String(text ?? ""));
}

function isPlainMattressCategory(name) {
  return /^mattress(?:es)?$/i.test(String(name ?? "").trim());
}

/**
 * Bedding name already on the store list.
 * Prefer a pads/toppers/protectors name, then a category named Bedding.
 * Returns "" when the list has neither. Never invents a name.
 */
export function beddingCategoryName(list) {
  const options = categoryChoices(list).filter((name) => !isPlainMattressCategory(name));
  const specific = options.find((name) => (
    /\b(?:pads?|toppers?|protectors?)\b/i.test(name) && /\bmattress|\bbedding\b/i.test(name)
  ));
  if (specific) return specific;
  return options.find((name) => /^bedding$/i.test(name.trim())) || "";
}

/**
 * Pick one store category after a scan.
 * Exact catalog names win. Otherwise one store name (or its singular) must appear in the product text.
 * Mattress pads, toppers, and protectors never map to Mattresses.
 * When nothing honest matches, return Uncategorized (or the first list name) so Receive can save.
 */
export function matchReceiveCategory(list, hints = {}) {
  const options = categoryChoices(list);
  const fallback =
    options.find((name) => /^uncategorized$/i.test(name)) || options[0] || "";
  const catalog = String(hints.category ?? "").trim();
  const blob = [catalog, hints.title, hints.brand, hints.model].map((part) => String(part ?? "")).join(" ").toLowerCase();
  if (isMattressAccessory(blob)) {
    const bedding = beddingCategoryName(options);
    if (bedding) return bedding;
    const exact = options.find((name) => name.toLowerCase() === catalog.toLowerCase());
    if (exact && !isPlainMattressCategory(exact)) return exact;
    return fallback;
  }
  if (!blob.trim()) return fallback;
  const exact = options.find((name) => name.toLowerCase() === catalog.toLowerCase());
  if (exact) return exact;
  const hits = options.filter((name) => {
    const label = name.toLowerCase();
    if (label === "uncategorized") return false;
    if (blob.includes(label)) return true;
    const stems = [];
    if (label.endsWith("es")) stems.push(label.slice(0, -2));
    if (label.endsWith("s")) stems.push(label.slice(0, -1));
    return stems.some((stem) => stem.length >= 5 && blob.includes(stem));
  });
  if (hits.length === 1) return hits[0];
  // Prefer a unique strongest word overlap with the eBay path / title (e.g. Cookware).
  const tokens = blob.split(/[^a-z0-9]+/).filter((t) => t.length >= 4);
  let best = null;
  for (const name of options) {
    if (/^uncategorized$/i.test(name)) continue;
    const label = name.toLowerCase();
    const parts = label.split(/[^a-z0-9]+/).filter((t) => t.length >= 4);
    const score = parts.reduce((n, part) => n + (tokens.includes(part) || blob.includes(part) ? part.length : 0), 0);
    if (score <= 0) continue;
    if (!best || score > best.score) best = { name, score };
    else if (best && score === best.score && name !== best.name) best = { name: "", score }; // tie → fall back
  }
  if (best?.name) return best.name;
  return fallback;
}
