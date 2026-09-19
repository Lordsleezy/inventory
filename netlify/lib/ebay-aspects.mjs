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

export function parseMeasure(raw) {
  const n = parseFloat(String(raw ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseMeasureRange(label) {
  const t = String(label || "").toLowerCase();
  const nums = [...String(label || "").matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => parseFloat(m[1]));
  if (!nums.length) return null;
  if (/more than|greater than|over|or more|and up|and above|at least/.test(t)) {
    const inclusive = /or more|and up|and above|at least/.test(t);
    return { min: nums[0], max: Infinity, inclusiveMin: inclusive, inclusiveMax: true, unit: labelUnit(t) };
  }
  if (/less than|under/.test(t)) {
    return { min: 0, max: nums[0], inclusiveMin: true, inclusiveMax: false, unit: labelUnit(t) };
  }
  if (/up to|or less|and under/.test(t)) {
    return { min: 0, max: nums[0], inclusiveMin: true, inclusiveMax: true, unit: labelUnit(t) };
  }
  if (nums.length >= 2) {
    return {
      min: Math.min(nums[0], nums[1]),
      max: Math.max(nums[0], nums[1]),
      inclusiveMin: true,
      inclusiveMax: true,
      unit: labelUnit(t),
    };
  }
  return {
    min: nums[0],
    max: nums[0],
    inclusiveMin: true,
    inclusiveMax: true,
    unit: labelUnit(t),
    exact: true,
  };
}

function labelUnit(label) {
  const t = String(label || "").toLowerCase();
  if (/\bcm\b|centimet/.test(t) && !/\bin(?:ch)?\b/.test(t)) return "cm";
  return "in";
}

function inRange(range, value) {
  if (range.exact || range.min === range.max) {
    const slop = range.unit === "cm" ? 1.5 : 0.51;
    return Math.abs(value - range.min) <= slop;
  }
  const ge = range.inclusiveMin ? value >= range.min : value > range.min;
  const le = range.max === Infinity ? true : range.inclusiveMax ? value <= range.max : value < range.max;
  return ge && le;
}

export function matchMeasureBucket(allowed, raw) {
  const inches = parseMeasure(raw);
  if (inches == null) return "";
  const hits = [];
  for (const label of allowed || []) {
    const range = parseMeasureRange(label);
    if (!range) continue;
    const value = range.unit === "cm" ? inches * 2.54 : inches;
    if (inRange(range, value)) hits.push({ label, range });
  }
  if (!hits.length) return "";
  hits.sort((a, b) => {
    const aInch = a.range.unit === "in" ? 0 : 1;
    const bInch = b.range.unit === "in" ? 0 : 1;
    if (aInch !== bInch) return aInch - bInch;
    const aSpan = a.range.max === Infinity ? Number.POSITIVE_INFINITY : a.range.max - a.range.min;
    const bSpan = b.range.max === Infinity ? Number.POSITIVE_INFINITY : b.range.max - b.range.min;
    if (aSpan !== bSpan) return aSpan - bSpan;
    return b.range.min - a.range.min;
  });
  return hits[0].label;
}

export function specInches(specs, kind) {
  const keys =
    kind === "height"
      ? ["height_in", "height", "product_height_in", "cabinet_height_in"]
      : kind === "depth"
        ? ["depth_in", "depth", "depth_without_handles_in", "depth_without_doors_in", "product_depth_in"]
        : ["width_in", "width", "cabinet_width_in", "product_width_in", "w_in"];
  for (const key of keys) {
    const n = parseMeasure(specs?.[key]);
    if (n) return n;
  }
  const nested = specs?.dimensions || specs?.size || {};
  const nestedKeys = kind === "height" ? ["height", "h"] : kind === "depth" ? ["depth", "length", "d"] : ["width", "w"];
  for (const key of nestedKeys) {
    const n = parseMeasure(nested?.[key]);
    if (n) return n;
  }
  const blob = Object.values(specs || {})
    .filter((v) => typeof v === "string")
    .join(" | ");
  const sized = blob.match(
    /(\d+(?:\.\d+)?)\s*"?\s*W\s*[×x]\s*(\d+(?:\.\d+)?)\s*"?\s*H(?:\s*[×x]\s*(\d+(?:\.\d+)?))?/i,
  );
  if (sized) {
    const pick = kind === "width" ? sized[1] : kind === "height" ? sized[2] : sized[3];
    const n = parseMeasure(pick);
    if (n) return n;
  }
  return null;
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
  const name = String(aspect?.localizedAspectName || aspect?.aspectName || "").toLowerCase();
  if (name === "color" || name === "colour") {
    const simple = wants.find((w) => /^\s*[a-z][a-z\s-]{2,24}\s*$/i.test(w) && !/,/.test(w));
    return simple || "";
  }
  return wants[0] || "";
}

function allowedList(aspect) {
  return (aspect?.aspectValues || []).map((v) => v.localizedValue || v.value).filter(Boolean);
}

function looksLikeCatalogModels(allowed) {
  if ((allowed || []).length < 4) return false;
  const models = allowed.filter(
    (a) => /[a-z].*\d|\d.*[a-z]/i.test(a) && !/in\b|inch|more than|less than|cu\s*ft/i.test(a),
  );
  return models.length / allowed.length > 0.5;
}

function candidatesForAspect(name, unit, specs) {
  const lower = name.toLowerCase();
  const brand = String(unit.brand || "").trim();
  const model = String(specs?.matched_model || unit.model || "").trim();
  const appliance = String(unit.category || unit.title || "").trim();
  const layout = String(specs?.configuration || "").trim();
  const finish = String(specs?.finish || "").trim();
  const install = String(specs?.installation || "").trim();
  if (lower === "brand") return [brand];
  if (lower === "mpn" || lower === "manufacturer part number") return [model];
  if (lower === "model") return [model];
  if (lower === "type") return [appliance, layout];
  if (lower === "color" || lower === "colour") return [finish];
  if (lower === "installation") return [install, "Freestanding"];
  if (/height/.test(lower)) return [specInches(specs, "height"), specs?.height_in];
  if (/width/.test(lower)) return [specInches(specs, "width"), specs?.width_in];
  if (/depth|length/.test(lower) && !/wave|band/.test(lower)) return [specInches(specs, "depth"), specs?.depth_in];
  if (/capacity/.test(lower)) return [specs?.capacity_cu_ft];
  if (/voltage/.test(lower)) return [specs?.voltage];
  if (/energy/.test(lower)) return [specs?.energy];
  if (/ice/.test(lower)) return [specs?.ice_maker];
  if (/water/.test(lower)) return [specs?.water_dispenser];
  return [install, appliance, layout, finish, brand, model];
}

export function aspectsFromTaxonomy(rows, unit, specs) {
  const model = String(specs?.matched_model || unit.model || "").trim();
  const aspects = {};
  const missing = [];
  for (const aspect of rows || []) {
    const name = String(aspect?.localizedAspectName || aspect?.aspectName || "").trim();
    if (!name) continue;
    const required = Boolean(aspect?.aspectConstraint?.aspectRequired);
    const lower = name.toLowerCase();
    const allowed = allowedList(aspect);
    let value = "";
    if (lower === "model") {
      value = model;
    } else if (/height|width|depth|length|capacity/.test(lower) && allowed.length) {
      const kind = /capacity/.test(lower)
        ? "capacity"
        : /height/.test(lower)
          ? "height"
          : /depth|length/.test(lower)
            ? "depth"
            : "width";
      const measure = kind === "capacity" ? specs?.capacity_cu_ft : specInches(specs, kind);
      value = matchMeasureBucket(allowed, measure);
    } else if (looksLikeCatalogModels(allowed) && /model|mpn/.test(lower)) {
      value = model;
    } else {
      value = pickAspectValue(aspect, candidatesForAspect(name, unit, specs));
    }
    if (value) aspects[name] = [String(value)];
    else if (required) {
      const examples = allowed.slice(0, 8);
      const field =
        /height/.test(lower)
          ? "height"
          : /width/.test(lower)
            ? "width"
            : /depth|length/.test(lower)
              ? "depth"
              : /install/.test(lower)
                ? "installation"
                : /model/.test(lower)
                  ? "model"
                  : "";
      missing.push(
        examples.length
          ? `${name} (set ${field || "it"} on the unit; eBay examples: ${examples.join(", ")})`
          : `${name} (set ${field || "it"} on the unit screen)`,
      );
    }
  }
  return { aspects, missing };
}
