import test from "node:test";
import assert from "node:assert/strict";
import { buyLabelForOrder, labelQuote, shippoMatchesOrder, voidLabel } from "./web-label.mjs";
import { pickDefaultRate } from "./shippo.mjs";

const R = (id, cents, days, carrier = "USPS", service = "Svc") => ({ id, amount_cents: cents, days, carrier, service });

test("default label rate: cheapest that is as fast or faster than what the customer paid for", () => {
  const rates = [R("a", 900, 5), R("b", 1100, 3), R("c", 1500, 3), R("d", 2400, 1), R("e", 800, 7)];
  assert.equal(pickDefaultRate(rates, { days: 3 }).rate.id, "b"); // cheaper-but-slower a and e are skipped
  assert.equal(pickDefaultRate(rates, { days: 5 }).rate.id, "a");
  assert.equal(pickDefaultRate(rates, { days: 1 }).rate.id, "d");
  assert.equal(pickDefaultRate([R("x", 900, 5), R("y", 700, 4)], { days: 2 }).rate.id, "y"); // nothing that fast: fastest available
  assert.equal(pickDefaultRate(rates, { days: null }).rate.id, "e"); // flat-rate fallback order: cheapest
  assert.equal(pickDefaultRate([], { days: 3 }), null);
});

test("Shippo test key can never touch a real paid order (and the live key never a sandbox order)", () => {
  assert.equal(shippoMatchesOrder({ payment_env: "production" }, "test").ok, false);
  assert.equal(shippoMatchesOrder({ payment_env: "production" }, "live").ok, true);
  assert.equal(shippoMatchesOrder({ payment_env: "sandbox" }, "test").ok, true);
  assert.equal(shippoMatchesOrder({ payment_env: "sandbox" }, "live").ok, false);
  assert.equal(shippoMatchesOrder({ payment_env: "production" }, null).ok, false);
});

function labelDb(order, unit = { package_length_in: 12, package_width_in: 10, package_height_in: 8, package_weight_lb: 4, dims_source: "estimated" }) {
  const log = { updates: [], inserts: [], deletes: [] };
  const state = { order: { ...order } };
  const q = (table) => {
    const ctx = { table, filters: {}, op: "select" };
    const api = {
      select() { return api; }, eq(k, v) { ctx.filters[k] = v; return api; }, is() { return api; }, or() { return api; },
      update(v) { ctx.op = "update"; ctx.vals = v; return api; }, insert(v) { ctx.op = "insert"; ctx.vals = v; return api; }, delete() { ctx.op = "delete"; return api; },
      async maybeSingle() { return run(); }, async single() { return run(); },
      then(res) { return Promise.resolve(run()).then(res); },
    };
    function run() {
      if (ctx.op === "insert") { log.inserts.push([table, ctx.vals]); return { data: { id: "lbl-1" }, error: null }; }
      if (ctx.op === "delete") { log.deletes.push(table); return { error: null }; }
      if (ctx.op === "update") {
        log.updates.push([table, ctx.vals]);
        if (table === "web_orders") { state.order = { ...state.order, ...ctx.vals }; return { data: state.order, error: null }; }
        return { data: { id: "x" }, error: null };
      }
      if (table === "web_orders") return { data: state.order, error: null };
      if (table === "units") return { data: unit, error: null };
      if (table === "store_settings") return { data: { value: ctx.filters.key === "ship_from" ? { name: "Open Box" } : "owner-uuid" }, error: null };
      if (table === "web_order_labels") return { data: { id: "lbl-1" }, error: null };
      return { data: null, error: null };
    }
    return api;
  };
  return { sb: { from: q }, log, state };
}

const paidOrder = {
  id: "o1", order_no: "OB-1001", sku: "11", status: "paid", fulfillment: "ship", payment_env: "sandbox", shipping_cents: 900,
  shipping_rate: { carrier: "USPS", service: "Ground Advantage", days: 5, source: "shippo" },
  buyer_name: "A", ship_line1: "1 St", ship_city: "NYC", ship_region: "NY", ship_postal: "10001", tracking_number: null, label_url: null,
};

test("label quote re-quotes with the corrected (bigger, heavier) box and pre-selects per the speed rule", async () => {
  const { sb } = labelDb(paidOrder);
  let seen;
  const liveRates = async ({ pkg }) => { seen = pkg; return { all: [R("slow", 1500, 6), R("cheap5", 1800, 5), R("fast", 2600, 2)], rates: [], messages: [] }; };
  const r = await labelQuote(sb, "store", "o1", { length_in: 18, width_in: 14, height_in: 12, weight_lb: 11 }, { liveRates, mode: "test" });
  assert.equal(r.ok, true);
  assert.deepEqual(seen, { length_in: 18, width_in: 14, height_in: 12, weight_lb: 11 });
  assert.equal(r.selected_id, "cheap5"); // paid a 5-day service: cheapest 5-day-or-faster, not the cheaper 6-day
  assert.equal(r.order.paid_shipping_cents, 900);
  assert.equal(r.stored_box.weight_lb, 4);
});

test("buying saves the measured box, logs the label expense, and records the label", async () => {
  const { sb, log } = labelDb(paidOrder);
  const deps = {
    mode: "test", getRate: async () => R("cheap5", 1800, 5, "UPS", "Ground"), deliver: async () => [],
    buyLabel: async () => ({ status: "SUCCESS", object_id: "tx1", tracking_number: "1Z999", tracking_url_provider: "https://t/1Z999", label_url: "https://l/1.pdf" }),
  };
  const r = await buyLabelForOrder(sb, "store", "o1", { rateId: "cheap5", box: { length_in: 18, width_in: 14, height_in: 12, weight_lb: 11 }, actor: "admin@x" }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.cost_cents, 1800);
  const unitUpdate = log.updates.find(([t]) => t === "units")[1];
  assert.equal(unitUpdate.dims_source, "measured");
  assert.equal(unitUpdate.package_weight_lb, 11);
  const expense = log.inserts.find(([t]) => t === "portal_expenses")[1];
  assert.equal(expense.amount_cents, 1800);
  assert.equal(expense.source, "label");
  assert.equal(expense.needs_reimbursement, true);
  assert.equal(expense.employee_id, "owner-uuid");
  assert.match(expense.description, /OB-1001/);
  assert.ok(log.inserts.some(([t]) => t === "web_order_labels"));
});

test("a failed Shippo purchase charges nothing and records nothing", async () => {
  const { sb, log } = labelDb(paidOrder);
  const r = await buyLabelForOrder(sb, "store", "o1", { rateId: "r", box: { length_in: 1, width_in: 1, height_in: 1, weight_lb: 1 } },
    { mode: "test", getRate: async () => R("r", 500, 3), buyLabel: async () => ({ status: "ERROR", messages: [{ text: "address invalid" }] }) });
  assert.equal(r.ok, false);
  assert.match(r.error, /address invalid/);
  assert.equal(log.inserts.length, 0);
});

test("void label: Shippo refund, expense reversed, tracking cleared; refuses once shipped", async () => {
  const labeled = { ...paidOrder, label_transaction_id: "tx1", tracking_number: "1Z999", label_url: "u" };
  const { sb, log } = labelDb(labeled);
  const r = await voidLabel(sb, "store", "o1", { refundLabel: async () => ({ status: "QUEUED" }) });
  assert.equal(r.ok, true);
  assert.ok(log.updates.some(([t, v]) => t === "portal_expenses" && v.void_reason === "label voided"));
  const cleared = log.updates.filter(([t]) => t === "web_orders").pop()[1];
  assert.equal(cleared.tracking_number, null);
  assert.equal(cleared.label_url, null);
  assert.ok(log.deletes.includes("web_order_emails"));
  const shipped = labelDb({ ...labeled, shipped_at: "2026-10-04" });
  assert.equal((await voidLabel(shipped.sb, "store", "o1", { refundLabel: async () => ({ status: "QUEUED" }) })).status, 409);
  const rejected = labelDb(labeled);
  assert.equal((await voidLabel(rejected.sb, "store", "o1", { refundLabel: async () => ({ status: "ERROR" }) })).ok, false);
});
