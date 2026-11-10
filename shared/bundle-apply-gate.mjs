/**
 * Bundle price apply / shipping refund / combined invoice / combined-weight enable.
 * OFF by default. Set FLOOR_BUNDLE_PRICE_APPLY=1 only if Paul turns it back on.
 * Tracking uploads for multi-item boxes (action: tracking) stay allowed.
 */
export function bundlePriceApplyEnabled() {
  return String(process.env.FLOOR_BUNDLE_PRICE_APPLY || "").trim() === "1";
}

export const BUNDLE_PRICE_APPLY_OFF_MESSAGE =
  "Bundle price apply is off (FLOOR_BUNDLE_PRICE_APPLY). Nothing was sent.";
