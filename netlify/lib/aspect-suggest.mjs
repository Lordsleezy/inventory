// Pure, dependency-free helpers for eBay item specifics: which value fits, which values to show first, which are valid.
// No AI: word matching against eBay's own allowed values, plus values already used on other Floor units.

const text = (v) => String(v ?? "").trim();
const defName = (def) => text(def?.name);
const isListOnly = (def) => Boolean((def?.selectionOnly || def?.selection_only) && def?.allowed?.length);

/** Aspects whose values come from Floor's own fields, never guessed from words. */
const IDENTITY = /^(brand|mpn|model|upc|ean|isbn|manufacturer part number)$/i;
/** Huge lists (Brand has ~14,000 values) are never word-matched. */
const MAX_MATCH_LIST = 800;

function stem(word) {
  let w = word.toLowerCase().replace(/['’]s$/, "").replace(/[^a-z0-9.+-]/g, "");
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  return w;
}
function tokens(s) {
  return text(s).split(/[\s/,&()]+/).map(stem).filter(Boolean);
}

/**
 * The one allowed value whose words appear (in order, as whole words) in the item's title / brand / model text.
 * Longest phrase wins ("Reading Glasses" beats "Glasses"); a tie between different values returns null.
 */
export function matchAllowedFromText(def, ...sources) {
  const allowed = def?.allowed || [];
  if (!allowed.length || allowed.length > MAX_MATCH_LIST || IDENTITY.test(defName(def))) return null;
  const hay = tokens(sources.filter(Boolean).join(" "));
  if (!hay.length) return null;
  let best = null;
  let tie = false;
  for (const value of allowed) {
    const needle = tokens(value);
    if (!needle.length || needle.join("").length < 3) continue;
    let found = false;
    for (let i = 0; i + needle.length <= hay.length && !found; i++) {
      found = needle.every((w, k) => hay[i + k] === w);
    }
    if (!found) continue;
    const score = needle.join(" ").length;
    if (!best || score > best.score) { best = { value, score }; tie = false; }
    else if (score === best.score && value !== best.value) tie = true;
  }
  return best && !tie ? best.value : null;
}

/** True when the value is acceptable for this aspect in this category. Blank is never acceptable. */
export function isValidValue(def, value) {
  const v = text(value);
  if (!v) return false;
  if (isListOnly(def)) return def.allowed.includes(v);
  return true;
}

/** The exact allowed spelling of a value (case-insensitive), or the value itself when free text is fine; null if not usable. */
export function canonicalValue(def, value) {
  const v = text(value);
  if (!v) return null;
  if (def?.allowed?.length) {
    const hit = def.allowed.find((a) => a.toLowerCase() === v.toLowerCase());
    if (hit) return hit;
  }
  return isListOnly(def) ? null : v;
}

/**
 * Keep only values that are still valid in the (new) category. Aspects the category does not have are dropped too.
 * Returns { kept, cleared } where cleared lists the aspect names that were removed.
 */
export function clearInvalid(fields = [], attributes = {}) {
  const byName = new Map((fields || []).map((def) => [defName(def).toLowerCase(), def]));
  const kept = {};
  const cleared = [];
  for (const [name, value] of Object.entries(attributes || {})) {
    if (!text(value)) continue;
    const def = byName.get(name.toLowerCase());
    if (def && isValidValue(def, value)) kept[def.name] = text(value);
    else cleared.push(name);
  }
  return { kept, cleared };
}

/** Required aspects that are blank or hold a value eBay does not allow. [{ name, reason: 'missing' | 'not_allowed' }] */
export function aspectProblems(fields = [], attributes = {}) {
  const out = [];
  for (const def of fields || []) {
    if (!def.required) continue;
    const v = text(attributes?.[def.name]);
    if (!v) out.push({ name: def.name, reason: "missing" });
    else if (!isValidValue(def, v)) out.push({ name: def.name, reason: "not_allowed" });
  }
  return out;
}

/** Counts of the values used across units: [{ Name: { value: count } }] -> { Name: { value: count } }. */
export function countUsage(attributeSets = []) {
  const usage = {};
  for (const attrs of attributeSets) {
    for (const [name, raw] of Object.entries(attrs || {})) {
      const v = text(raw);
      if (!v) continue;
      (usage[name] ||= {})[v] = (usage[name][v] || 0) + 1;
    }
  }
  return usage;
}

/** Allowed values with the ones used most in Floor first (by count), then the rest in eBay's order. */
export function rankValues(def, usageForAspect = {}) {
  const allowed = def?.allowed || [];
  const used = Object.entries(usageForAspect || {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v]) => v);
  const first = used.filter((v) => !allowed.length || allowed.includes(v) || !isListOnly(def));
  const seen = new Set(first);
  return [...first, ...allowed.filter((v) => !seen.has(v))];
}

/** The most common value among other units' complete specifics for this aspect that is valid here. */
export function commonSiblingValue(def, siblingAttributes = []) {
  const counts = new Map();
  for (const attrs of siblingAttributes) {
    const v = canonicalValue(def, attrs?.[def.name]);
    if (v) counts.set(v, (counts.get(v) || 0) + 1);
  }
  let best = null;
  for (const [v, n] of counts) if (!best || n > best.n) best = { v, n };
  return best?.v || null;
}

/** Word-match suggestions for every required (and recommended) aspect that is still blank. */
export function textSuggestions(fields = [], attributes = {}, ...sources) {
  const out = {};
  for (const def of fields || []) {
    if (!(def.required || def.recommended) || text(attributes?.[def.name])) continue;
    const value = matchAllowedFromText(def, ...sources);
    if (value) out[def.name] = value;
  }
  return out;
}
