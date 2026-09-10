import { moneyStringToCents, type Cents } from "./money.ts";

export type LocationAskAction = "migrate" | "skip" | "conflict" | "invalid";

export type LocationAskPreview = {
  sku: string;
  brand: string;
  model: string;
  currentLocation: string | null;
  currentAskCents: Cents | null;
  proposedAskCents: Cents | null;
  action: LocationAskAction;
};

/** Last path segment, so "Warehouse/999" is treated as "999". */
export function locationLeaf(location: string | null | undefined): string {
  if (location == null) return "";
  const parts = location
    .trim()
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.at(-1) ?? "";
}

/**
 * Location was used as a dollar amount. A clean number is digits with an
 * optional 1–2 decimal places — no $, commas, or words. Returns integer cents.
 */
export function parseLocationAsAskCents(location: string | null | undefined): Cents | null {
  const leaf = locationLeaf(location);
  if (!leaf) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(leaf)) return null;
  return moneyStringToCents(leaf);
}

/** Ask if set; otherwise a clean numeric location treated as dollars. Never zero. */
export function displayAskCents(unit: { askCents: Cents | null; location: string | null }): Cents | null {
  if (unit.askCents != null && unit.askCents !== 0) return unit.askCents;
  const fromLocation = parseLocationAsAskCents(unit.location);
  if (fromLocation != null && fromLocation !== 0) return fromLocation;
  return null;
}

export function previewLocationAsk(unit: {
  sku: string;
  brand: string;
  model: string;
  location: string | null;
  askCents: Cents | null;
}): LocationAskPreview {
  const leaf = locationLeaf(unit.location);
  const currentLocation = unit.location?.trim() ? unit.location : null;
  const proposedAskCents = parseLocationAsAskCents(unit.location);
  const base = {
    sku: unit.sku,
    brand: unit.brand,
    model: unit.model,
    currentLocation,
    currentAskCents: unit.askCents,
    proposedAskCents,
  };
  if (!leaf) return { ...base, proposedAskCents: null, action: "skip" };
  if (proposedAskCents === null) return { ...base, action: "invalid" };
  if (unit.askCents !== null) return { ...base, action: "conflict" };
  return { ...base, action: "migrate" };
}
