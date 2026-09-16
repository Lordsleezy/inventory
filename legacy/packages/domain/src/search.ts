import { displayAskCents } from "./location-ask.ts";
import { isSku, type Unit } from "./unit.ts";

export type UnitQuery = {
  q?: string;
  queue?: "inspect" | "price" | "unlisted" | "error" | "voided" | "nophoto" | "aging30" | "aging60" | "aging90" | "sold";
  includeVoided?: boolean;
};

/** SKU, brand, model, title only — the inventory search box. */
export function matchesInventoryQuery(unit: Unit, raw?: string): boolean {
  const q = raw?.trim().toLowerCase() ?? "";
  if (!q) return true;
  const fields = [unit.sku, unit.brand, unit.model, unit.title].map((value) =>
    String(value ?? "").toLowerCase(),
  );
  return q
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => fields.some((field) => field.includes(token)));
}

function ageDays(receivedOn: string, now = Date.now()): number | null {
  if (!receivedOn) return null;
  const t = new Date(receivedOn).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((now - t) / (24 * 60 * 60 * 1000));
}

export function filterUnits(units: Unit[], query: UnitQuery): Unit[] {
  let out = units.filter((unit) => isSku(unit.sku));
  if (query.queue !== "voided" && query.queue !== "sold" && !query.includeVoided) {
    out = out.filter((unit) => unit.state !== "voided" && unit.state !== "sold");
  }
  if (query.q?.trim()) {
    out = out.filter((unit) => matchesInventoryQuery(unit, query.q));
  }
  switch (query.queue) {
    case "inspect":
      return out.filter((unit) => unit.condition === null);
    case "price":
      return out.filter((unit) => displayAskCents(unit) === null);
    case "unlisted":
      return out.filter(
        (unit) => displayAskCents(unit) !== null && !unit.listings.some((l) => l.state === "LISTED"),
      );
    case "error":
      return out.filter((unit) => unit.recordError !== null);
    case "voided":
      return units.filter((unit) => isSku(unit.sku) && unit.state === "voided");
    case "sold":
      return units.filter((unit) => isSku(unit.sku) && unit.state === "sold");
    case "nophoto":
      return out.filter((unit) => unit.photoCount === 0);
    case "aging30":
      return out.filter((unit) => {
        const days = ageDays(unit.receivedOn);
        return days !== null && days >= 30 && days < 60 && unit.state !== "sold";
      });
    case "aging60":
      return out.filter((unit) => {
        const days = ageDays(unit.receivedOn);
        return days !== null && days >= 60 && days < 90 && unit.state !== "sold";
      });
    case "aging90":
      return out.filter((unit) => {
        const days = ageDays(unit.receivedOn);
        return days !== null && days >= 90 && unit.state !== "sold";
      });
    default:
      return out;
  }
}
