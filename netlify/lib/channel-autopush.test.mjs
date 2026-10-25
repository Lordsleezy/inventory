import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runAutopush, processRow, classifyFailure, normalizeSetting, queuePublish, floorListPriceCents } from "./channel-autopush.mjs";

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

test("temporary eBay 20/hour cadence expires; Amazon and TikTok remain on 10-minute cadence", async () => {
  const rows = [row(1, "e", "ebay"), row(2, "a", "amazon"), row(3, "t", "tiktok")];
  const published = [];
  const deps = { publish: async (_s, ch, sku) => { published.push(`${ch}:${sku}`); return { ok: true }; }, end: async () => ({ ok: true }) };
  const setting = { enabled: true, ebay_enabled: true, per_run: { ebay: 1, amazon: 1, tiktok: 1 }, ebay_rate_until: "2026-11-01T12:30:00.000Z" };
  const boosted = fakeDb({ setting, rows });
  await runAutopush({ db: boosted, deps, now: new Date("2026-11-01T12:03:00.000Z") });
  assert.deepEqual(published, ["ebay:e"]);
  published.length = 0;
  const normal = fakeDb({ setting, rows });
  await runAutopush({ db: normal, deps, now: new Date("2026-11-01T12:04:00.000Z") });
  assert.deepEqual(published, []);
  const ebayTick = fakeDb({ setting, rows });
  await runAutopush({ db: ebayTick, deps, now: new Date("2026-11-01T12:09:00.000Z") });
  assert.deepEqual(published, ["ebay:e"]);
  published.length = 0;
  const regularTick = fakeDb({ setting, rows });
  await runAutopush({ db: regularTick, deps, now: new Date("2026-11-01T12:10:00.000Z") });
  assert.deepEqual(published, ["amazon:a", "tiktok:t"]);
  published.length = 0;
  published.length = 0;
  const expired = fakeDb({ setting, rows });
  await runAutopush({ db: expired, deps, now: new Date("2026-11-01T12:33:00.000Z") });
  assert.deepEqual(published, []);
  const expiredRegularTick = fakeDb({ setting, rows });
  await runAutopush({ db: expiredRegularTick, deps, now: new Date("2026-11-01T12:40:00.000Z") });
  assert.deepEqual(published, ["ebay:e", "amazon:a", "tiktok:t"]);
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

test("queue readiness passes the target channel so UPC requirements stay channel-specific", async () => {
  const db = fakeDb({ setting: {} });
  db.gaps = async (_s, _sku, channel) => channel === 'ebay' ? [] : ['upc'];
  let published=0;
  const deps={publish:async()=>{published++;return {ok:true};}};
  assert.equal((await processRow(db,deps,row(1,'no-upc','ebay'),now)).status,'done');
  assert.equal((await processRow(db,deps,row(2,'no-upc','amazon'),now)).issue,'Missing: upc');
  assert.equal((await processRow(db,deps,row(3,'no-upc','tiktok'),now)).issue,'Missing: upc');
  assert.equal(published,1);
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

test("queue listings: Floor price, +10% under $15", async () => {
  const calls = [];
  const deps = {
    loadUnit: async () => ({ sku: "10", ask_cents: 4999, retail_cents: 20000, is_collectible: true }),
    existingListing: async () => null,
    publish: async (_s, args) => { calls.push(args); return { ok: true, url: "u" }; },
  };
  for (const ch of ["ebay", "amazon", "tiktok"]) await queuePublish(deps, "s1", ch, "10");
  assert.deepEqual(calls.map((c) => c.priceCents), [4999, 4999, 4999]);
  assert.equal(floorListPriceCents({ ask_cents: 0 }), null);
  assert.equal(floorListPriceCents({ ask_cents: 999 }), 1099);
  assert.equal(floorListPriceCents({ ask_cents: 1499 }), 1649);
  assert.equal(floorListPriceCents({ ask_cents: 1001 }), 1101);
  assert.equal(floorListPriceCents({ ask_cents: 1500 }), 1500);
  assert.equal(floorListPriceCents({ ask_cents: 2500 }), 2500);
  const none = await queuePublish({ ...deps, loadUnit: async () => ({ ask_cents: null }) }, "s1", "ebay", "10");
  assert.equal(none.ok, false);
  assert.equal(classifyFailure("ebay", none.error).retryable, false);
});

test("queue never edits or reprices a listing that already exists on the channel", async () => {
  let published = false;
  const r = await queuePublish({
    loadUnit: async () => ({ ask_cents: 1000 }),
    existingListing: async () => ({ url: "https://www.ebay.com/itm/1" }),
    publish: async () => { published = true; return { ok: true }; },
  }, "s1", "ebay", "10");
  assert.equal(published, false);
  assert.deepEqual(r, { ok: true, already_live: true, url: "https://www.ebay.com/itm/1" });
});

test("queue path has no Promoted Listings / Marketing API step", () => {
  for (const f of ["./channel-autopush.mjs", "../functions/channel-autopush.mjs"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.doesNotMatch(src, /sell\/marketing|promot|campaign|bidPercentage/i, f);
  }
});
