/** Shown when a SKU is still on an open online order (weight / pack / ship / pickup). */
export const ONLINE_ORDER_RESERVED_MESSAGE = 'This item is reserved for an online order.';

export type OnlineOrderHold = {
  held: boolean;
  sku?: string;
  orderNo?: string | null;
  channel?: string | null;
  fulfillment?: string | null;
};

/** True when register must refuse adding this SKU because of an open online order. */
export function isOnlineOrderHeld(payload: unknown): payload is OnlineOrderHold & { held: true } {
  return !!payload && typeof payload === 'object' && (payload as OnlineOrderHold).held === true;
}
