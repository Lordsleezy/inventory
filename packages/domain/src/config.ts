export type FloorChannel = {
  id: string;
  label: string;
  enabled: boolean;
};

export type MarketplaceConfig = {
  unrestricted: boolean;
};

export type FloorConfig = {
  storeName: string;
  storeAddress: string;
  storeEmail: string;
  returnPolicy: string;
  skuStart: number;
  taxRateBps: number;
  retailStaleDays: number;
  photoDropPath: string;
  conditions: string[];
  testStatuses: string[];
  paymentMethods: string[];
  locations: string[];
  channels: FloorChannel[];
  marketplace: MarketplaceConfig;
};

export const DEFAULT_RETURN_POLICY =
  "All items are used or open-box and sold as-is. Please inspect the appliance before you leave. Returns are accepted within 7 days with this receipt if the item is in the same condition as sold. No warranty is expressed or implied unless stated in writing on this receipt.";

export const DEFAULT_FLOOR_CONFIG: FloorConfig = {
  storeName: "Open Box Industries",
  storeAddress: "3121 Penryn Rd, Penryn, CA 95663",
  storeEmail: "",
  returnPolicy: DEFAULT_RETURN_POLICY,
  skuStart: 11111,
  taxRateBps: 0,
  retailStaleDays: 60,
  photoDropPath: "",
  conditions: ["Excellent", "Good", "Fair", "Defective"],
  testStatuses: ["untested", "passed", "failed", "partial"],
  paymentMethods: ["cash", "card", "other"],
  locations: ["Receiving", "Floor", "Back"],
  channels: [
    { id: "ebay", label: "eBay", enabled: true },
    { id: "facebook", label: "Facebook", enabled: true },
    { id: "tiktok", label: "TikTok", enabled: true },
    { id: "amazon", label: "Amazon", enabled: false },
  ],
  marketplace: { unrestricted: true },
};

export function parseFloorConfig(raw: unknown): FloorConfig {
  if (!raw || typeof raw !== "object") {
    return {
      ...DEFAULT_FLOOR_CONFIG,
      channels: DEFAULT_FLOOR_CONFIG.channels.map((c) => ({ ...c })),
      marketplace: { ...DEFAULT_FLOOR_CONFIG.marketplace },
    };
  }
  const row = raw as Record<string, unknown>;
  const skuStart = Number(row.skuStart ?? DEFAULT_FLOOR_CONFIG.skuStart);
  if (!Number.isInteger(skuStart) || skuStart < 0 || skuStart > 99999) {
    throw new Error(`skuStart must be an integer 0–99999, got ${row.skuStart}`);
  }
  const taxRateBps = Number(row.taxRateBps ?? 0);
  if (!Number.isInteger(taxRateBps) || taxRateBps < 0) {
    throw new Error(`taxRateBps must be a non-negative integer (basis points), got ${row.taxRateBps}`);
  }
  const market =
    row.marketplace && typeof row.marketplace === "object"
      ? (row.marketplace as Record<string, unknown>)
      : {};
  return {
    storeName: String(row.storeName ?? DEFAULT_FLOOR_CONFIG.storeName),
    storeAddress: String(row.storeAddress ?? DEFAULT_FLOOR_CONFIG.storeAddress),
    storeEmail: String(row.storeEmail ?? DEFAULT_FLOOR_CONFIG.storeEmail).trim(),
    returnPolicy: String(row.returnPolicy ?? DEFAULT_FLOOR_CONFIG.returnPolicy).trim() || DEFAULT_RETURN_POLICY,
    skuStart,
    taxRateBps,
    retailStaleDays: Number(row.retailStaleDays ?? 60) || 60,
    photoDropPath: String(row.photoDropPath ?? ""),
    conditions: Array.isArray(row.conditions) ? row.conditions.map(String) : [...DEFAULT_FLOOR_CONFIG.conditions],
    testStatuses: Array.isArray(row.testStatuses)
      ? row.testStatuses.map(String)
      : [...DEFAULT_FLOOR_CONFIG.testStatuses],
    paymentMethods: Array.isArray(row.paymentMethods)
      ? row.paymentMethods.map(String)
      : [...DEFAULT_FLOOR_CONFIG.paymentMethods],
    locations: Array.isArray(row.locations) ? row.locations.map(String) : [...DEFAULT_FLOOR_CONFIG.locations],
    channels: Array.isArray(row.channels)
      ? row.channels.map((ch) => {
          const c = ch as FloorChannel;
          return { id: String(c.id), label: String(c.label ?? c.id), enabled: Boolean(c.enabled) };
        })
      : DEFAULT_FLOOR_CONFIG.channels.map((c) => ({ ...c })),
    marketplace: {
      unrestricted:
        market.unrestricted === undefined ? DEFAULT_FLOOR_CONFIG.marketplace.unrestricted : Boolean(market.unrestricted),
    },
  };
}

export function assertInspectFields(
  config: FloorConfig,
  input: { condition: string | null; testStatus: string },
) {
  if (input.condition && !config.conditions.includes(input.condition)) {
    throw Object.assign(
      new Error(`Condition must be one of: ${config.conditions.join(", ")}`),
      { status: 400 },
    );
  }
  if (!config.testStatuses.includes(input.testStatus)) {
    throw Object.assign(
      new Error(`Test status must be one of: ${config.testStatuses.join(", ")}`),
      { status: 400 },
    );
  }
}

export function isRetailStale(capturedOn: string | null, staleDays: number, now = new Date()): boolean {
  if (!capturedOn) return false;
  const captured = new Date(capturedOn);
  if (Number.isNaN(captured.getTime())) return true;
  const ageMs = now.getTime() - captured.getTime();
  return ageMs > staleDays * 24 * 60 * 60 * 1000;
}
