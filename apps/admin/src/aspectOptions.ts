// What the eBay item-specific picker shows. Pure so it can be tested: allowed values, most used in Floor first, live filtering,
// and the "Use '<typed>'" option only where eBay allows free text.
export type AspectDef = { name: string; required?: boolean; recommended?: boolean; allowed?: string[]; selection_only?: boolean };

export const MAX_SHOWN = 60;

export const isListOnly = (def: AspectDef) => Boolean(def.selection_only && def.allowed?.length);

/** Allowed values, with the values most used in Floor for this category first. */
export function rankedOptions(def: AspectDef, usage: string[] = []): string[] {
  const allowed = def.allowed || [];
  const first = usage.filter(v => !isListOnly(def) || allowed.includes(v));
  const seen = new Set(first);
  return [...first, ...allowed.filter(v => !seen.has(v))];
}

/** What to list for the text typed so far. `typed` is offered as its own choice only for free-text aspects. */
export function pickerOptions(def: AspectDef, usage: string[], query: string): { options: string[]; typed: string | null; more: number } {
  const q = query.trim().toLowerCase();
  const all = rankedOptions(def, usage);
  const matches = q ? all.filter(v => v.toLowerCase().includes(q)) : all;
  const exact = q ? all.some(v => v.toLowerCase() === q) : true;
  return {
    options: matches.slice(0, MAX_SHOWN),
    typed: !isListOnly(def) && q && !exact ? query.trim() : null,
    more: Math.max(0, matches.length - MAX_SHOWN),
  };
}

/** A value eBay accepts for this aspect in this category (blank never is). */
export function valueIsValid(def: AspectDef, value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  return isListOnly(def) ? Boolean(def.allowed?.includes(v)) : true;
}
