import { isSku, type Unit } from "./unit.ts";

export type UnitQuery = {
  q?: string;
  queue?: "inspect" | "price" | "unlisted" | "error" | "voided" | "nophoto" | "aging30" | "aging60" | "aging90";
  includeVoided?: boolean;
};

function haystack(unit: Unit): string {
  return [
    unit.sku,
    unit.brand,
    unit.model,
    unit.title,
    unit.category,
    unit.condition ?? "",
    unit.state,
    unit.testStatus,
    unit.location ?? "",
    unit.lot ?? "",
    unit.mfrSerial ?? "",
  ]
    .join(" ")
    .toLowerCase();
}

function ageDays(receivedOn: string, now = Date.now()): number | null {
  if (!receivedOn) return null;
  const t = new Date(receivedOn).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((now - t) / (24 * 60 * 60 * 1000));
}

export function filterUnits(units: Unit[], query: UnitQuery): Unit[] {
  let out = units.filter((unit) => isSku(unit.sku));
  if (query.queue !== "voided" && !query.includeVoided) {
    out = out.filter((unit) => unit.state !== "voided");
  }
  const q = query.q?.trim().toLowerCase();
  if (q) out = out.filter((unit) => haystack(unit).includes(q));
  switch (query.queue) {
    case "inspect":
      return out.filter((unit) => unit.condition === null);
    case "price":
      return out.filter((unit) => unit.askCents === null);
    case "unlisted":
      return out.filter(
        (unit) => unit.askCents !== null && !unit.listings.some((l) => l.state === "LISTED"),
      );
    case "error":
      return out.filter((unit) => unit.recordError !== null);
    case "voided":
      return units.filter((unit) => isSku(unit.sku) && unit.state === "voided");
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
