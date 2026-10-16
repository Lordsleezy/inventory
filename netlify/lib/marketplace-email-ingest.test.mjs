/**
 * Audit: every detected Depop/Mercari sale must create (or find) a web_orders row.
 * Unmatched sales must never be dropped into review-only limbo.
 */
import assert from "node:assert/strict";
import { ingestMarketplaceMail, marketplaceOrderKey } from "./marketplace-email-parse.mjs";

function mockSb() {
  const state = {
    emailSales: [],
    webOrders: [],
    channelOrders: [],
    units: [],
    inserts: { marketplace_email_sales: 0, web_orders: 0 },
  };

  const api = {
    from(table) {
      const ctx = { table, filters: {}, payload: null, op: "select" };
      const builder = {
        select() {
          return builder;
        },
        insert(row) {
          ctx.op = "insert";
          ctx.payload = row;
          return builder;
        },
        upsert(row) {
          ctx.op = "upsert";
          ctx.payload = row;
          return builder;
        },
        delete() {
          ctx.op = "delete";
          return builder;
        },
        eq(k, v) {
          ctx.filters[k] = v;
          return builder;
        },
        not() {
          return builder;
        },
        limit() {
          return builder;
        },
        maybeSingle: async () => {
          if (ctx.op === "insert") {
            if (table === "marketplace_email_sales") {
              state.inserts.marketplace_email_sales += 1;
              const row = { id: state.emailSales.length + 1, ...ctx.payload };
              state.emailSales.push(row);
              return { data: row, error: null };
            }
            if (table === "web_orders") {
              state.inserts.web_orders += 1;
              const row = { id: `wo-${state.webOrders.length + 1}`, ...ctx.payload };
              state.webOrders.push(row);
              return { data: { id: row.id }, error: null };
            }
          }
          if (ctx.op === "delete") {
            state.emailSales = state.emailSales.filter((r) => r.id !== ctx.filters.id);
            return { data: null, error: null };
          }
          if (table === "marketplace_email_sales") {
            const row = state.emailSales.find(
              (r) =>
                (!ctx.filters.store_id || r.store_id === ctx.filters.store_id) &&
                (!ctx.filters.message_id || r.message_id === ctx.filters.message_id) &&
                (!ctx.filters.order_number || r.order_number === ctx.filters.order_number),
            );
            return { data: row || null, error: null };
          }
          if (table === "web_orders") {
            const row = state.webOrders.find(
              (r) =>
                (!ctx.filters.store_id || r.store_id === ctx.filters.store_id) &&
                (!ctx.filters.payment_id || r.payment_id === ctx.filters.payment_id),
            );
            return { data: row ? { id: row.id, match_status: row.match_status, sku: row.sku } : null, error: null };
          }
          if (table === "units") {
            const row = state.units.find((r) => r.sku === ctx.filters.sku);
            return { data: row || null, error: null };
          }
          return { data: null, error: null };
        },
        then: undefined,
      };
      // Make await sb.from().insert() work when callers don't use maybeSingle
      builder.then = (resolve, reject) =>
        builder
          .maybeSingle()
          .then(resolve, reject);
      return builder;
    },
    rpc: async () => ({ data: null, error: { message: "not used in unmatched path" } }),
    _state: state,
  };
  return api;
}

const store = { id: "store-1" };
const channels = [{ key: "depop", aliases: ["depop"] }, { key: "mercari", aliases: ["mercari"] }];

{
  const sb = mockSb();
  const parsed = {
    subject: "Your USPS shipping label and sale confirmation for @newbuyer.",
    text: "You've made a sale!\nItem price $22.00\nShip to:\nPat\n1 Main St\nAustin, TX 78701",
    from: { address: "sold@alerts.depop.com" },
    messageId: "<audit-depop-1@geopod>",
  };
  const result = await ingestMarketplaceMail(sb, {
    store,
    channels,
    parsed,
    raw: "Message-ID: <audit-depop-1@geopod>\n\nbody",
  });
  assert.equal(result.state, "needs_review");
  assert.ok(result.web_order_id, "unmatched Depop sale must create web_orders id");
  assert.equal(result.order_created, true);
  assert.equal(sb._state.inserts.web_orders, 1);
  assert.equal(sb._state.webOrders[0].match_status, "unmatched");
  assert.equal(sb._state.webOrders[0].sku, "UNMATCHED");
  assert.equal(sb._state.webOrders[0].item_cents, 2200);
  assert.equal(sb._state.webOrders[0].channel, "depop");
  const key = marketplaceOrderKey({ orderNumber: null, messageId: "<audit-depop-1@geopod>" });
  assert.equal(sb._state.webOrders[0].payment_id, `marketplace:depop:${key}`);
}

{
  // Second pass (INCLUDE_SEEN): same Message-ID must not create a second Orders row.
  const sb = mockSb();
  const parsed = {
    subject: "Your USPS shipping label and sale confirmation for @newbuyer.",
    text: "You've made a sale!\nItem price $22.00",
    from: { address: "sold@alerts.depop.com" },
    messageId: "<audit-depop-2@geopod>",
  };
  const raw = "Message-ID: <audit-depop-2@geopod>\n\nbody";
  const first = await ingestMarketplaceMail(sb, { store, channels, parsed, raw });
  assert.equal(first.order_created, true);
  const second = await ingestMarketplaceMail(sb, { store, channels, parsed, raw });
  assert.equal(second.state, "needs_review");
  assert.equal(second.order_created, false);
  assert.equal(second.stable, true);
  assert.equal(sb._state.inserts.web_orders, 1, "dedupe: only one web_orders row");
}

{
  const sb = mockSb();
  const parsed = {
    subject: "You've made a sale: Kitchen Timer",
    text: "You've made a sale!\nSold for $9.50\nSKU 11410",
    from: { address: "no-reply@mercari.com" },
    messageId: "<audit-mercari-1@x>",
  };
  // Unit not available → unmatched Orders still required
  sb._state.units.push({ sku: "11410", title: "Kitchen Timer", state: "sold" });
  const result = await ingestMarketplaceMail(sb, {
    store,
    channels,
    parsed,
    raw: "Message-ID: <audit-mercari-1@x>\n\n",
  });
  assert.equal(result.state, "needs_review");
  assert.ok(result.web_order_id);
  assert.equal(sb._state.webOrders[0].channel, "mercari");
  assert.equal(sb._state.webOrders[0].item_cents, 950);
}

console.log("marketplace-email-ingest.test.mjs ok");
