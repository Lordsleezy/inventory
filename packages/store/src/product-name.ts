const SELLER_BRAND = /\b(?:gallery\s*(?:&|and)\s* gifts?|store|shop|outlet|llc|incorporated|inc|wholesale|deals?|retailer|seller)\b/i;
const RETAIL_TAIL = /\b(?:\d+\s*)?(?:ea(?:ch)?|ct|pk)\b/gi;
const TRAILING_SEPARATORS = /[\s,;|/\-–—]+$/;
const ACRONYMS = new Set(["AI", "HD", "LED", "USB", "TV", "USB-C", "XL", "XXL", "UPC", "MPN"]);
const GENERIC_PRODUCT_WORDS = new Set(["lamp", "lights", "light", "desk", "chair", "table", "frame", "frames", "diffuser", "device", "home", "mini", "smart", "fragrance", "product", "item", "new", "the", "this"]);

function titleCase(value: string): string {
  return value.split(/(\s+)/).map(part => {
    if (!part.trim()) return part;
    return part.split(/([-/'’])/).map(bit => {
      if (!bit || /^[-/'’]$/.test(bit)) return bit;
        if (/[A-Z]/.test(bit) && /\d/.test(bit) && /^[A-Z0-9-]+$/.test(bit)) return bit;
      if (ACRONYMS.has(bit.toUpperCase())) return bit.toUpperCase();
      return bit.charAt(0).toUpperCase() + bit.slice(1).toLowerCase();
    }).join("");
  }).join("");
}

function cleanWords(value: unknown): string {
  let text = String(value ?? "")
    .normalize("NFKC")
    .replace(/[™®©]/g, "")
    .replace(/[\uFFFD\u00C2\u00A0]/g, " ")
    .replace(RETAIL_TAIL, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = text.split(" ");
  const unique: string[] = [];
  for (const word of words) {
    if (unique.length && unique[unique.length - 1].toLowerCase() === word.toLowerCase()) continue;
    unique.push(word);
  }
  text = unique.join(" ").replace(TRAILING_SEPARATORS, "").trim();
  return titleCase(text);
}

function brandIsSeller(value: string): boolean {
  return Boolean(value) && SELLER_BRAND.test(value);
}

function inferBrand(candidate: string, description: string, sourceTitle: string): string {
  // Only promote a name that appears in another product source. Never infer from
  // arbitrary first words in a description unless the title confirms the same word.
  const desc = cleanWords(description);
  const title = cleanWords(sourceTitle);
  const candidates = [...candidate.matchAll(/[A-Za-z][A-Za-z0-9&'-]*/g)].map(x => x[0]);
  for (const raw of candidates) {
    const word = cleanWords(raw);
    if (word.length < 2 || GENERIC_PRODUCT_WORDS.has(word.toLowerCase())) continue;
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`, "i").test(desc) && new RegExp(`\\b${escaped}\\b`, "i").test(title)) return word;
  }
  return "";
}

function withoutBrand(value: string, brand: string): string {
  if (!brand) return value;
  return value.replace(new RegExp(`^\\s*${brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b[\s:,-]*`, "i"), "").trim();
}

function limitTitle(value: string, max = 80): string {
  if (value.length <= max) return value;
  const clipped = value.slice(0, max + 1);
  const boundary = clipped.lastIndexOf(" ");
  return (boundary > 0 ? clipped.slice(0, boundary) : clipped.slice(0, max)).trim();
}

export type ProductIdentity = { brand: string; model: string; title: string; review: boolean; reasons: string[] };

/** Clean lookup/AI identity fields conservatively. `review` means a person should verify the result. */
export function cleanProductIdentity(input: {
  brand?: unknown; model?: unknown; title?: unknown; description?: unknown;
}): ProductIdentity {
  const rawBrand = cleanWords(input.brand);
  const rawModel = cleanWords(input.model);
  const rawTitle = cleanWords(input.title);
  const description = cleanWords(input.description);
  const reasons: string[] = [];
  let brand = rawBrand;
  if (brandIsSeller(rawBrand)) {
    brand = inferBrand(`${rawTitle} ${description}`, description, rawTitle);
    reasons.push(brand ? "seller_brand_replaced_from_product_sources" : "seller_brand_rejected");
  } else if (!rawBrand) {
    brand = inferBrand(`${rawTitle} ${description}`, description, rawTitle);
  }
  if (!brand) reasons.push("brand_needs_review");
  let model = withoutBrand(rawModel || rawTitle, brand);
  model = cleanWords(model);
  if (!model) model = withoutBrand(rawTitle, brand);
  if (!model) reasons.push("model_missing");
  let title = cleanWords([brand, model].filter(Boolean).join(" ") || rawTitle);
  title = limitTitle(title);
  if (title.split(/\s+/).filter(Boolean).length < 3) reasons.push("title_too_short");
  const titleTerms = new Set(title.toLowerCase().split(/\W+/).filter(Boolean));
  const descriptionTerms = new Set(description.toLowerCase().split(/\W+/).filter(Boolean));
  const overlap = [...titleTerms].filter(word => word.length > 2 && descriptionTerms.has(word)).length;
  if (descriptionTerms.size > 4 && overlap === 0) reasons.push("description_conflict_review");
  return { brand, model, title, review: reasons.length > 0, reasons: [...new Set(reasons)] };
}
