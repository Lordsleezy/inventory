/**
 * Doba adapter — DISABLED / unused.
 * Kept so Paul can compare against the earlier feat/dropship-bot work if he pushes it.
 * Do not call. Do not delete without saying so in the report.
 */
const disabled = async () => {
  const err = new Error("doba_disabled_unused");
  err.code = "disabled";
  throw err;
};

export const dobaAdapter = {
  id: "doba",
  label: "Doba (unused)",
  enabled: false,
  statusHint: "disabled — too expensive; kept for reference",

  async testConnection() {
    return { ok: false, detail: "disabled / unused" };
  },
  listCatalog: disabled,
  getProduct: disabled,
  liveStock: disabled,
  shippingEstimate: disabled,
  placeOrder: disabled,
  getTracking: disabled,
  async getBalance() {
    return { balanceCents: null, pointsRemaining: null, currency: "USD" };
  },
};
