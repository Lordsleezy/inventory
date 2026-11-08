/**
 * EPROLO adapter slot — waiting for API docs from Paul / EPROLO support.
 * Same interface as CJ. Fails closed. Do not invent endpoints.
 */
const waiting = async () => {
  const err = new Error("eprolo_waiting_for_api_docs");
  err.code = "waiting_docs";
  throw err;
};

export const eproloAdapter = {
  id: "eprolo",
  label: "EPROLO",
  enabled: false,
  statusHint: "waiting for API docs",

  async testConnection() {
    return { ok: false, detail: "waiting for API docs" };
  },
  listCatalog: waiting,
  getProduct: waiting,
  liveStock: waiting,
  shippingEstimate: waiting,
  placeOrder: waiting,
  getTracking: waiting,
  async getBalance() {
    return { balanceCents: null, pointsRemaining: null, currency: "USD" };
  },
};
