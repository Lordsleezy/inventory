import assert from "node:assert/strict";
import { photoIdsFromHtml, syncDepopListingPhotos } from "./depop-photo-sync.mjs";

assert.deepEqual(
  photoIdsFromHtml(
    '<img src="https://media-photos.depop.com/b1/481279620/4955799423_0680165964224f8d85ef55abae729c7c/P0.jpg">',
  ),
  ["4955799423"],
);

{
  const updates = [];
  const sb = {
    from() {
      return {
        update(payload) {
          this._payload = payload;
          return this;
        },
        eq() {
          return this;
        },
        then(resolve) {
          updates.push(this._payload);
          resolve({ error: null });
        },
      };
    },
  };
  // Make awaitable chain
  sb.from = () => {
    const ctx = { filters: {}, payload: null };
    const builder = {
      update(p) {
        ctx.payload = p;
        return builder;
      },
      eq(k, v) {
        ctx.filters[k] = v;
        return builder;
      },
      then(resolve, reject) {
        updates.push({ ...ctx });
        Promise.resolve({ error: null }).then(resolve, reject);
      },
    };
    return builder;
  };

  const summary = await syncDepopListingPhotos(sb, {
    storeId: "store-1",
    manual: [{ sku: "99119", photo_ids: ["4955799423", "bad"] }],
  });
  assert.equal(summary.updated, 1);
  assert.equal(summary.source, "manual");
  assert.deepEqual(updates[0].payload.photo_ids, ["4955799423"]);
}

console.log("depop-photo-sync.test.mjs ok");
