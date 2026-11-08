/**
 * Printify (POD) — likely next supplier for branded merch.
 * Slot only until API wiring is requested.
 */
const waiting = async () => {
  const err = new Error("printify_waiting_for_setup");
  err.code = "waiting_docs";
  throw err;
};

export const printifyAdapter = {
  id: "printify",
  label: "Printify",
  enabled: false,
  statusHint: "waiting for setup",

  async testConnection() {
    return { ok: false, detail: "waiting for setup" };
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
