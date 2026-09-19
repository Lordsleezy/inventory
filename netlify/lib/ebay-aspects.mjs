function norm(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function candidateParts(...values) {
  const out = [];
  for (const value of values) {
    for (const part of String(value || "").split(/[,/;|]+/)) {
      const t = part.trim();
      if (t && !out.includes(t)) out.push(t);
    }
  }
  return out;
}

export function matchAllowedValue(allowed, candidates) {
  const list = (allowed || []).map((v) => String(v || "").trim()).filter(Boolean);
  const wants = candidateParts(...(candidates || []));
  if (!list.length) return "";
  for (const want of wants) {
    const hit = list.find((a) => a.toLowerCase() === want.toLowerCase());
    if (hit) return hit;
  }
  for (const want of wants) {
    const n = norm(want);
    if (n.length < 3) continue;
    const hits = list.filter((a) => {
      const an = norm(a);
      return an === n || an.includes(n) || n.includes(an);
    });
    if (hits.length === 1) return hits[0];
    const exact = hits.find((a) => norm(a) === n);
    if (exact) return exact;
  }
  for (const want of wants) {
    const tokens = norm(want).split(/\s+/).filter((t) => t.length >= 3);
    for (const tok of tokens) {
      const hits = list.filter((a) => {
        const parts = norm(a).split(/\s+/);
        return parts.includes(tok) || norm(a) === tok;
      });
      if (hits.length === 1) return hits[0];
      const exact = hits.find((a) => norm(a) === tok);
      if (exact) return exact;
    }
  }
  return "";
}

export function pickAspectValue(aspect, candidates) {
  const allowed = (aspect?.aspectValues || []).map((v) => v.localizedValue || v.value).filter(Boolean);
  const wants = candidateParts(...(candidates || []));
  if (allowed.length) return matchAllowedValue(allowed, wants);
  // Free-text aspects: Brand/MPN/Model may be open. Still reject long marketing blobs for Color.
  const name = String(aspect?.localizedAspectName || aspect?.aspectName || "").toLowerCase();
  if (name === "color" || name === "colour") {
    const simple = wants.find((w) => /^\s*[a-z][a-z\s-]{2,24}\s*$/i.test(w) && !/,/.test(w));
    return simple || "";
  }
  return wants[0] || "";
}

export function aspectsFromTaxonomy(rows, unit, specs) {
  const brand = String(unit.brand || "").trim();
  const model = String(specs?.matched_model || unit.model || "").trim();
  const appliance = String(unit.category || unit.title || "").trim();
  const layout = String(specs?.configuration || "").trim();
  const finish = String(specs?.finish || "").trim();
  const aspects = {};
  const missing = [];
  for (const aspect of rows || []) {
    const name = String(aspect?.localizedAspectName || aspect?.aspectName || "").trim();
    if (!name) continue;
    const required = Boolean(aspect?.aspectConstraint?.aspectRequired);
    const lower = name.toLowerCase();
    let value = "";
    if (lower === "brand") value = pickAspectValue(aspect, [brand]);
    else if (lower === "mpn" || lower === "manufacturer part number") value = pickAspectValue(aspect, [model]);
    else if (lower === "model") value = pickAspectValue(aspect, [model]);
    else if (lower === "type") value = pickAspectValue(aspect, [appliance, layout]);
    else if (lower === "color" || lower === "colour") value = pickAspectValue(aspect, [finish]);
    else if (required) value = pickAspectValue(aspect, [appliance, brand, model, layout]);
    if (value) aspects[name] = [String(value)];
    else if (required) {
      const allowed = (aspect.aspectValues || [])
        .map((v) => v.localizedValue || v.value)
        .filter(Boolean)
        .slice(0, 8);
      missing.push(
        allowed.length
          ? `${name} (need a value eBay accepts; examples: ${allowed.join(", ")})`
          : name,
      );
    }
  }
  return { aspects, missing };
}
