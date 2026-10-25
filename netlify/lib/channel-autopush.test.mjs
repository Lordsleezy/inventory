import test from "node:test";
import assert from "node:assert/strict";
import { runAutopush, processRow, classifyFailure, normalizeSetting } from "./channel-autopush.mjs";

function fakeDb({ setting, rows = [], live = {}, never = {}, gaps = {}, selected = true }) {
  const updates = [];
  return {
    updates,
    settings: async () => [{ store_id: "s1", value: setting }],
    dueRows: async (_s, channel, limit) => rows.filter((r) => r.channel === channel).slice(0, limit),
    claim: async () => true,
    update: async (id, patch) => { updates.push({ id, ...patch }); },
    selected: async () => selected,
    neverReason: async (_s, sku, ch) => never[`${sku}:${ch}`] || null,
    live: async (_s, sku, ch) => Boolean(live[`${sku}:${ch}`]),
    gaps: async (_s, sku) => gaps[sku] || [],
    listingRow: async (_s, sku, ch) => ({ channel: ch, offer_id: `offer-${sku}` }),
  };
}
const row = (id, sku, channel, action = "list", attempts = 0) => ({ id, store_id: "s1", sku, channel, action, attempts });
const now = new Date("2026-11-01T12:00:00Z");

test("queue does nothing while switched off (default)", async () => {
  const calls = [];
  for (const setting of [undefined, {}, { enabled: false, ebay_enabled: true }]) {
    const db = fakeDb({ setting, rows: [row(1, "1", "amazon"), row(2, "2", "ebay")] });
    const out = await runAutopush({ db, deps: { publish: async (...a) => { calls.push(a); return { ok: true }; }, end: async () => ({}) }, now });
    assert.deepEqual(out.results, [{ storeId: "s1", skipped: "disabled" }]);
    assert.equal(db.updates.length, 0);
  }
  assert.equal(calls.length, 0);
  assert.equal(normalizeSetting(undefined).enabled, false);
});

test("eBay is never touched until ebay_enabled; other channels still run", async () => {
  const published = [];
  const db = fakeDb({ setting: { enabled: true }, rows: [row(1, "1", "ebay"), row(2, "2", "amazon"), row(3, "3", "tiktok")] });
  await runAutopush({ db, deps: { publish: async (_s, ch, sku) => { published.push(`${sku}:${ch}`); return { ok: true, url: "u" }; }, end: async () => ({}) }, now });
  assert.deepEqual(published, ["2:amazon", "3:tiktok"]);
  assert.equal(db.updates.find((u) => u.id === 1), undefined);
});

test("one channel failing does not stop the others; drip limit per channel", async () => {
  const published = [];
  const db = fakeDb({ setting: { enabled: true, ebay_enabled: true, per_run: { ebay: 1, amazon: 1, tiktok: 1 } },
    rows: [row(1, "1", "ebay"), row(4, "4", "ebay"), row(2, "2", "amazon"), row(3, "3", "tiktok")] });
  await runAutopush({ db, deps: { publish: async (_s, ch, sku) => {
    published.push(`${sku}:${ch}`);
    if (ch === "ebay") throw new Error("HTTP 503");
    return { ok: true, url: `https://x/${sku}` };
  }, end: async () => ({}) }, now });
  assert.deepEqual(published, ["1:ebay", "2:amazon", "3:tiktok"]);
  const ebay = db.updates.find((u) => u.id === 1);
  assert.equal(ebay.status, "queued");
  assert.equal(ebay.attempts, 1);
  assert.match(ebay.issue, /Retrying/);
  assert.equal(db.updates.find((u) => u.id === 2).listing_ref, "https://x/2");
});

test("never re-lists a unit that is already live (no duplicates)", async () => {
  let called = false;
  const db = fakeDb({ setting: {}, live: { "9:ebay": true } });
  const patch = await processRow(db, { publish: async () => { called = true; return { ok: true }; } }, row(1, "9", "ebay"), now);
  assert.equal(patch.status, "done");
  assert.equal(patch.listing_ref, "already_live");
  assert.equal(called, false);
});

test("missing mandatory fields wait in the queue with the reason", async () => {
  const db = fakeDb({ setting: {}, gaps: { "5": ["photo", "spec"] } });
  const patch = await processRow(db, { publish: async () => assert.fail("must not publish") }, row(1, "5", "amazon"), now);
  assert.equal(patch.status, "queued");
  assert.equal(patch.issue, "Missing: photo, spec");
});

test("never-list and unchecked units are not published", async () => {
  const deps = { publish: async () => assert.fail("must not publish") };
  const never = await processRow(fakeDb({ setting: {}, never: { "6:ebay": "Holiday Living lights" } }), deps, row(1, "6", "ebay"), now);
  assert.equal(never.status, "failed");
  const unchecked = await processRow(fakeDb({ setting: {}, selected: false }), deps, row(1, "6", "amazon"), now);
  assert.equal(unchecked.status, "cancelled");
});

test("unchecking a live channel ends that listing", async () => {
  const ended = [];
  const db = fakeDb({ setting: {}, live: { "7:tiktok": true } });
  const patch = await processRow(db, { end: async (_s, ch, item) => { ended.push([ch, item.sku, item.offer_id]); return { ok: true }; } }, row(1, "7", "tiktok", "end"), now);
  assert.equal(patch.status, "done");
  assert.deepEqual(ended, [["tiktok", "7", "offer-7"]]);
});

test("TikTok approval pending stays queued and visible; hard errors fail; retries stop at the limit", async () => {
  const db = fakeDb({ setting: {} });
  const tk = await processRow(db, { publish: async () => ({ ok: false, error: "seller identity verification pending" }) }, row(1, "8", "tiktok"), now);
  assert.equal(tk.status, "queued");
  assert.equal(tk.issue, "TikTok Shop approval pending");
  assert.equal(classifyFailure("amazon", "not_on_amazon").retryable, false);
  const last = await processRow(db, { publish: async () => ({ ok: false, error: "HTTP 500" }) }, row(1, "8", "amazon", "list", 4), now);
  assert.equal(last.status, "failed");
});
