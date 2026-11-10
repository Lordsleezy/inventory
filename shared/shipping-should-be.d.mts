export function billedPounds(pkg: unknown): number;
export function zone6LabelCents(pounds: number): number;
export function buyerShipCents(labelCents: number): number;
export function shouldBeShipCents(pkg: unknown, sameModelLabelCents?: number | null): number | null;
export function classifyShip(ebayCents: number, shouldCents: number): string;
export function packagesMatch(ebay: unknown, floor: unknown): boolean;
export function packageWrite(ebayPkg: unknown, floorPkg: unknown, ebayCents: number): {
  write: boolean;
  reason: string;
  should_cents: number | null;
};
