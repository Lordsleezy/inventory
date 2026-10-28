const NEVER_LIST = [
  [/\b(refrigerator|fridge|freezer)\b/i, "Floor policy: refrigerators/freezers are never listed"],
  [/\bdishwasher\b/i, "Floor policy: dishwashers are never listed"],
  [/\bdeep\s*fryer\b/i, "Floor policy: deep fryers are never listed"],
  [/\bmattress\b/i, "Floor policy: mattresses are never listed"],
  [/\bbed\s*frames?\b/i, "Floor policy: bed frames are never listed"],
  [/\bscooters?\b/i, "Floor policy: scooters are never listed"],
  [/\bchristmas\s*lights?\b/i, "Floor policy: Christmas lights are never listed"],
];

export function evaluateTikTokReadiness(unit, { photoCount = 0, taxonomyAvailable = false, connected = false,
  categoryMapped = false, categoryAllowed = false, requiredFields = null, attributes = {}, brandVerified = false } = {}) {
  const reasons = [];
  const text = [unit.title, unit.brand, unit.model, unit.category, unit.internal_category, unit.listing_body]
    .filter(Boolean).join(" ");
  for (const [pattern, reason] of NEVER_LIST) if (pattern.test(text)) reasons.push(reason);
  if (unit.listing_specs?.do_not_list === true || unit.do_not_list === true) reasons.push("Marked do-not-list");
  if (/defective/i.test(String(unit.condition || ""))) reasons.push("Condition is Defective");
  if (!String(unit.upc || "").trim()) reasons.push("UPC missing");
  if (!(Number(photoCount) > 0)) reasons.push("Unit photo missing");
  if (unit.has_ai_images === true) reasons.push("TikTok photo rules: AI-generated image flagged");
  if (unit.has_stock_photos === true) reasons.push("TikTok photo rules: stock image flagged");
  if (!Number(unit.ask_cents) || Number(unit.ask_cents) <= 0) reasons.push("Floor price missing");
  if (!/^new$/i.test(String(unit.condition || "").trim())) reasons.push("Condition is not confirmed new/sealed; open-box/used needs TikTok pre-owned approval");
  else if (unit.package_sealed !== true) reasons.push("New/sealed package status needs seller verification; opened packaging is pre-owned under TikTok policy");
  if (!taxonomyAvailable) reasons.push("TikTok category, required attributes, brand and product rules not synced");
  if (!categoryMapped) reasons.push("TikTok category mapping missing");
  else if (!categoryAllowed) reasons.push("TikTok category is unavailable, restricted, or not an active leaf");
  if (categoryMapped && requiredFields === null) reasons.push("TikTok required attributes/rules not fetched for mapped category");
  else if (Array.isArray(requiredFields)) {
    const missing = requiredFields.filter((field) => {
      const value = attributes?.[field.name];
      return value == null || value === "" || (Array.isArray(value) && value.length === 0);
    });
    if (missing.length) reasons.push(`Required TikTok attributes missing: ${missing.map((f) => f.label || f.name).join(", ")}`);
  }
  if (String(unit.brand || "").trim() && !brandVerified) reasons.push("TikTok brand authorization not verified for mapped category");
  if (!connected) reasons.push("TikTok Shop is not connected; shop/category eligibility cannot be verified");
  return { status: reasons.length ? "blocked" : "ready", reasons };
}

export function suggestedTikTokPriceCents(askCents) {
  const ask = Math.max(0, Math.round(Number(askCents) || 0));
  return ask > 0 && ask < 1500 ? Math.round(ask * 1.10) : ask;
}
