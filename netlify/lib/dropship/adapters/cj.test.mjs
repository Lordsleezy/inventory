import test from "node:test";
import assert from "node:assert/strict";
import { cjAdapter, createCjContext, __test } from "./cj.mjs";
import { ThrottledQueue, CJ_POINTS } from "../throttle.mjs";

test("flattenListV2 unwraps nested productList blocks", () => {
  const rows = __test.flattenListV2({
    content: [{ productList: [{ id: "a", nameEn: "A" }, { id: "b", nameEn: "B" }] }],
  });
  assert.equal(rows.length, 2);
});

test("mapListRow marks US list rows as shipsFromUs", () => {
  const item = __test.mapListRow({
    id: "pid1",
    nameEn: "Widget",
    nowPrice: "4.50",
    warehouseInventoryNum: 12,
    deliveryCycle: "2-4",
    bigImage: "https://example.com/x.png",
    threeCategoryName: "Tools",
  });
  assert.equal(item.supplierProductId, "pid1");
  assert.equal(item.costCents, 450);
  assert.equal(item.shipsFromUs, true);
  assert.equal(item.processingDays, 4);
  assert.equal(item.stockQty, 12);
});

test("mapProductDetail prefers US inventory row", () => {
  const item = __test.mapProductDetail(
    {
      pid: "p",
      productNameEn: "Thing",
      variants: [
        {
          vid: "v1",
          nowPrice: "3.00",
          inventory: [
            { countryCode: "CN", totalInventoryNum: 99, areaId: 9 },
            { countryCode: "US", totalInventoryNum: 5, areaId: 2, city: "Los Angeles", state: "CA", zip: "90001" },
          ],
        },
      ],
    },
    "v1",
  );
  assert.equal(item.shipsFromUs, true);
  assert.equal(item.stockQty, 5);
  assert.equal(item.warehouseCity, "Los Angeles");
  assert.equal(item.warehousePostal, "90001");
  assert.equal(item.supplierVariantId, "v1");
});

test("throttle refuses to burn past soft floor", () => {
  // 2040 - 50 = 1990 < softFloor 2000 → refuse
  const q = new ThrottledQueue({ pointsRemaining: 2040, softFloor: 2000, maxPointsPerRun: 8000 });
  assert.equal(q.canSpend(CJ_POINTS.LIST), false);
  q.pointsRemaining = 5000;
  assert.equal(q.canSpend(CJ_POINTS.LIST), true);
  q.recordSpend(CJ_POINTS.LIST);
  assert.equal(q.pointsSpent, 50);
  assert.equal(q.pointsRemaining, 4950);
});

test("throttle withBackoff retries 429 then succeeds", async () => {
  const q = new ThrottledQueue({ minIntervalMs: 0, pointsRemaining: 10000 });
  let n = 0;
  const result = await q.withBackoff(async () => {
    n += 1;
    if (n < 3) {
      const err = new Error("rate");
      err.status = 429;
      err.code = 1600200;
      throw err;
    }
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(n, 3);
});

test("cj placeOrder fails closed on bad address", async () => {
  const ctx = createCjContext({
    apiKey: "x",
    accessToken: "tok",
    row: { token_expires_at: new Date(Date.now() + 3600_000).toISOString() },
    pointsRemaining: 10000,
    async saveTokens() {},
  });
  await assert.rejects(
    () =>
      cjAdapter.placeOrder(ctx, {
        externalOrderId: "o1",
        supplierVariantId: "v",
        quantity: 1,
        address: { name: "A" },
      }),
    /bad_address/,
  );
});

test("createCjContext attaches queue", () => {
  const ctx = createCjContext({ pointsRemaining: 1000, row: {} });
  assert.ok(ctx.queue);
  assert.equal(ctx.queue.pointsRemaining, 1000);
});
