import type { UnitState } from "@floor/domain";

/**
 * InvenTree built-in stock status codes → Floor unit states.
 *
 * This is the only mapping. Every reader imports from here.
 *
 *   10 OK          available (reserved if allocated to a sales order)
 *   50 ATTENTION   repair
 *   55 DAMAGED     repair
 *   60 DESTROYED   scrapped
 *   65 REJECTED    voided   — not scrapped. Hidden from counts/queues.
 *   70 LOST        lost
 *   75 QUARANTINED repair
 *   85 RETURNED    available (reserved if allocated)
 *
 * Unknown codes must never fall through to available.
 */
export const STOCK_STATUS = {
  OK: 10,
  ATTENTION: 50,
  DAMAGED: 55,
  DESTROYED: 60,
  REJECTED: 65,
  LOST: 70,
  QUARANTINED: 75,
  RETURNED: 85,
} as const;

export type StockStatusCode = (typeof STOCK_STATUS)[keyof typeof STOCK_STATUS];

const CODE_TO_STATE = {
  [STOCK_STATUS.OK]: "available",
  [STOCK_STATUS.ATTENTION]: "repair",
  [STOCK_STATUS.DAMAGED]: "repair",
  [STOCK_STATUS.DESTROYED]: "scrapped",
  [STOCK_STATUS.REJECTED]: "voided",
  [STOCK_STATUS.LOST]: "lost",
  [STOCK_STATUS.QUARANTINED]: "repair",
  [STOCK_STATUS.RETURNED]: "available",
} as const satisfies Record<StockStatusCode, UnitState>;

export function statusCodeOf(status: unknown): number | null {
  if (typeof status === "number" && Number.isFinite(status)) return status;
  if (typeof status === "string" && /^\d+$/.test(status)) return Number(status);
  if (status && typeof status === "object" && typeof (status as { value?: unknown }).value === "number") {
    return (status as { value: number }).value;
  }
  return null;
}

export type StatusMapResult =
  | { state: UnitState; error: null }
  | { state: "repair"; error: string };

export function floorStateFromStatus(status: unknown, allocated: boolean): StatusMapResult {
  const code = statusCodeOf(status);
  if (code === null) {
    return { state: "repair", error: `unreadable stock status: ${JSON.stringify(status)}` };
  }
  const mapped = (CODE_TO_STATE as Record<number, UnitState | undefined>)[code];
  if (!mapped) {
    return { state: "repair", error: `unrecognized stock status ${code}` };
  }
  if ((mapped === "available" || mapped === "reserved") && allocated) {
    return { state: "reserved", error: null };
  }
  return { state: mapped, error: null };
}

export function statusForFloorState(state: "available" | "repair" | "scrapped" | "voided" | "lost"): StockStatusCode {
  switch (state) {
    case "available":
      return STOCK_STATUS.OK;
    case "repair":
      return STOCK_STATUS.QUARANTINED;
    case "scrapped":
      return STOCK_STATUS.DESTROYED;
    case "voided":
      return STOCK_STATUS.REJECTED;
    case "lost":
      return STOCK_STATUS.LOST;
  }
}
