import type { Unit } from "@floor/domain";
import type { FloorRole } from "./session";

export function redactUnit(unit: Unit, role: FloorRole): Unit {
  if (role === "admin") return unit;
  return { ...unit, floorCents: null, acquisitionCostCents: null };
}

export function redactSale<T extends { lines: { floorCents: number | null }[] }>(sale: T, role: FloorRole): T {
  if (role === "admin") return sale;
  return {
    ...sale,
    lines: sale.lines.map((line) => ({ ...line, floorCents: null })),
  };
}

export function requireAdmin(role: FloorRole) {
  if (role !== "admin") {
    throw Object.assign(new Error("Admin only"), { status: 403 });
  }
}
