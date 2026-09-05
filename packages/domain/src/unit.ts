import type { Cents } from "./money.ts";

export type UnitState =
  | "available"
  | "reserved"
  | "sold"
  | "repair"
  | "scrapped"
  | "lost"
  | "voided";

export type ListingState = "NOT_LISTED" | "LISTED" | "ENDED";

export type Listing = {
  channel: string;
  state: ListingState;
  url: string | null;
  listedOn: string | null;
};

export type RetailRef = {
  cents: Cents | null;
  retailer: string | null;
  capturedOn: string | null;
};

export type SaleRecord = {
  priceCents: Cents;
  channel: string;
  soldOn: string;
  salesOrderId: string;
};

export type VoidRecord = {
  reason: string;
  at: string;
  by: string;
};

export type Unit = {
  sku: string;
  stockId: number | null;
  brand: string;
  model: string;
  title: string;
  category: string;
  upc: string;
  /** How many units share this model (Part). 1 means this unit only. */
  sharedModelCount: number;
  location: string | null;
  lot: string | null;
  state: UnitState;
  condition: string | null;
  testStatus: string;
  defectNotes: string | null;
  mfrSerial: string | null;
  acquisitionCostCents: Cents | null;
  msrpCents: Cents | null;
  retail: RetailRef;
  askCents: Cents | null;
  floorCents: Cents | null;
  listings: Listing[];
  sale: SaleRecord | null;
  voided: VoidRecord | null;
  photoCount: number;
  primaryAttachmentId: number | null;
  receivedOn: string;
  /** Set when metadata or status cannot be trusted. Never sellable. */
  recordError: string | null;
};

export function isSku(value: string): boolean {
  return /^\d{5}$/.test(value);
}

export function padSku(n: number): string {
  return String(n).padStart(5, "0");
}

export function isPriced(unit: Unit): boolean {
  return unit.askCents !== null;
}

export function isListedAnywhere(unit: Unit): boolean {
  return unit.listings.some((l) => l.state === "LISTED");
}

export function isSellable(unit: Unit): boolean {
  return unit.state === "available" && unit.recordError === null;
}

export function hasPhotos(unit: Unit): boolean {
  return unit.photoCount > 0;
}
