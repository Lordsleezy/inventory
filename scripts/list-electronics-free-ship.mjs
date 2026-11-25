/**
 * One-off: list tonight's electronics on ikonikdeals2026.
 * Price = Floor ask + $5, free shipping, quantity = qty_on_hand.
 *
 *   node --experimental-strip-types scripts/list-electronics-free-ship.mjs
 */
import { serviceClient } from "../netlify/lib/server.mjs";
import { loadEbayAccount } from "../netlify/lib/ebay-accounts.mjs";
import { listSku } from "../netlify/lib/ebay.mjs";
import { ensureFreeShippingPolicy } from "../netlify/lib/ebay-free-ship-bump.mjs";
import { resolveBusinessPolicies } from "../netlify/lib/ebay-drafts.mjs";
import { ebayDescription } from "../netlify/lib/ebay-product.mjs";
import { composeChannelDescription, parseListingSpecs } from "../netlify/lib/listing-copy.mjs";
import { ebayItemViewUrl } from "../netlify/lib/ebay-env.mjs";

const SKUS = (process.argv.slice(2).filter((s) => /^\d+$/.test(s)).length
  ? process.argv.slice(2).filter((s) => /^\d+$/.test(s))
  : ["12482", "12483", "12484", "12485", "12486", "12487", "12488", "12489"]);
const BUMP_CENTS = 500;
const PACE_MS = 2000;
const SELLING_USERNAME = "ikonikdeals2026";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function titleForUnit(unit) {
  if (unit.ebay_title && String(unit.ebay_title).trim()) {
    let t = String(unit.ebay_title).trim();
    if (!/\bSKU\b/i.test(t)) t = `${t} | SKU ${unit.sku}`;
    return t.length > 80 ? `${t.slice(0, 77)}...` : t;
  }
  const name =
    [unit.brand, unit.model].filter((p) => String(p || "").trim()).join(" ").trim() ||
    unit.title ||
    `SKU ${unit.sku}`;
  const bits = [name, unit.condition].filter((p) => p && String(p).trim());
  let title = `${bits.join(" — ")} | SKU ${unit.sku}`;
  if (title.length > 80) title = `${title.slice(0, 77)}...`;
  return title;
}

function descriptionFor(unit) {
  const base = composeChannelDescription({
    listingBody: unit.listing_body,
    brand: unit.brand,
    model: unit.model,
    title: unit.title,
    specs: parseListingSpecs(unit.listing_specs),
    condition: unit.condition,
    testStatus: unit.test_status,
    defectNotes: unit.defect_notes,
    sku: unit.sku,
  });
  const cleaned = String(base)
    .replace(/\nSold as-is\. Local pickup unless arranged\.\s*$/i, "\nSold as-is.")
    .trim();
  return ebayDescription(`${cleaned}\n\nFREE shipping within the contiguous US.`, unit.sku);
}

function packagePayload(unit) {
  const length_in = Number(unit.package_length_in) || 12;
  const width_in = Number(unit.package_width_in) || 10;
  const height_in = Number(unit.package_height_in) || 3;
  const weight_lb = Number(unit.package_weight_lb) || 2;
  return {
    dimensions: {
      length: length_in,
      width: width_in,
      height: height_in,
      unit: "INCH",
    },
    weight: { value: weight_lb, unit: "POUND" },
  };
}

async function main() {
  const sb = serviceClient();
  const { data: stores, error: storeErr } = await sb.from("stores").select("id").limit(1);
  if (storeErr) throw storeErr;
  const storeId = stores[0].id;

  const account = await loadEbayAccount(storeId, { username: SELLING_USERNAME });
  if (String(account.role) !== "selling") throw new Error("expected selling account");
  // ensureFreeShippingPolicy picks a verified free flat policy (not the misnamed calculated "OBI Free Shipping").
  const freePol = await ensureFreeShippingPolicy(account);
  let paymentId = account.payment_policy_id || freePol.paymentPolicyId;
  let returnId = account.return_policy_id || freePol.returnPolicyId;
  const freeId = freePol.fulfillmentPolicyId;
  try {
    const resolved = await resolveBusinessPolicies(storeId);
    paymentId = resolved.payment || paymentId;
    returnId = resolved.returnP || returnId;
  } catch {
    /* keep account / ensured payment+return */
  }
  if (!freeId || !paymentId || !returnId) throw new Error("missing business policies");
  console.log(`free_ship_policy ${freePol.name} ${freeId}`);

  const { data: units, error: unitErr } = await sb
    .from("units")
    .select("*")
    .eq("store_id", storeId)
    .in("sku", SKUS);
  if (unitErr) throw unitErr;
  const bySku = new Map((units || []).map((u) => [u.sku, u]));

  const results = [];
  for (const sku of SKUS) {
    const unit = bySku.get(sku);
    if (!unit) {
      results.push({ sku, ok: false, error: "missing_unit" });
      continue;
    }
    const qty = Math.max(1, Math.trunc(Number(unit.qty_on_hand) || 1));
    const priceCents = Math.round(Number(unit.ask_cents) || 0) + BUMP_CENTS;
    if (!(priceCents > BUMP_CENTS)) {
      results.push({ sku, ok: false, error: "no_price" });
      continue;
    }

    const { data: live } = await sb
      .from("listings")
      .select("listing_id,status")
      .eq("store_id", storeId)
      .eq("sku", sku)
      .eq("channel", "ebay")
      .eq("status", "listed")
      .maybeSingle();
    if (live) {
      results.push({
        sku,
        ok: false,
        skipped: true,
        reason: "already_listed",
        listingId: live.listing_id,
        qty,
      });
      continue;
    }

    // Let listSku resolve Floor's confirmed eBay category/aspects/condition.
    const draft = {
      title: titleForUnit(unit),
      description: descriptionFor(unit),
      priceCents,
      quantity: qty,
      policies: { payment: paymentId, returnP: returnId, fulfillment: freeId },
      package: packagePayload(unit),
      bestOfferEnabled: false,
    };

    try {
      const listed = await listSku(storeId, sku, draft);
      results.push({
        sku,
        ok: true,
        qty,
        floor_cents: unit.ask_cents,
        price_cents: priceCents,
        listingId: listed.listingId,
        url: listed.viewUrl || ebayItemViewUrl(listed.listingId),
        title: draft.title,
      });
      console.log(`OK ${sku} qty=${qty} $${(priceCents / 100).toFixed(2)} free ship → ${listed.listingId}`);
    } catch (err) {
      const message = String(err?.message || err);
      results.push({ sku, ok: false, qty, error: message.slice(0, 400) });
      console.error(`FAIL ${sku} qty=${qty}: ${message.slice(0, 300)}`);
    }
    await sleep(PACE_MS);
  }

  const ok = results.filter((r) => r.ok);
  const pieces = ok.reduce((n, r) => n + (r.qty || 0), 0);
  console.log(JSON.stringify({ ok: ok.length, pieces, failed: results.length - ok.length, results }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
