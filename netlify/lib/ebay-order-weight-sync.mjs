/**
 * Push Jacob's verified item weight to the Open Box eBay listing (ikonikdeals2026 only).
 * Trading ReviseFixedPriceItem ShippingPackageDetails first; Inventory packageWeightAndSize fallback.
 * Never touches the personal orders-only account.
 */
import { loadEbayAccount, userTokenForAccount, ebayFetchAccount } from "./ebay-accounts.mjs";
import { EBAY_SELLING_USERNAME, assertEbaySellerWrite } from "./ebay-write-guard.mjs";
import { getItemShippingPackage, reviseFixedPricePackage } from "./ebay-trading.mjs";

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function inventoryPackage({ lengthIn, widthIn, heightIn, weightLb }) {
  const out = {
    weight: { value: String(weightLb), unit: "POUND" },
  };
  if (lengthIn && widthIn && heightIn) {
    const sides = [lengthIn, widthIn, heightIn].map((n) => Math.round(Number(n) * 100) / 100).sort((a, b) => b - a);
    out.dimensions = { length: String(sides[0]), width: String(sides[1]), height: String(sides[2]), unit: "INCH" };
  }
  return out;
}

async function mark(sb, orderId, patch) {
  const { error } = await sb.from("web_orders").update({
    ...patch,
    updated_at: new Date().toISOString(),
  }).eq("id", orderId);
  if (error) console.log("ebay_weight_sync_mark_failed", error.message);
}

/**
 * @returns {Promise<{ ok: boolean, skipped?: boolean, via?: string, message?: string, listingId?: string, listingStatus?: string }>}
 */
export async function syncVerifiedWeightToEbay(sb, storeId, order) {
  const channel = String(order?.channel || "").toLowerCase();
  const seller = String(order?.ebay_seller_username || "").trim().toLowerCase();
  if (channel !== "ebay") {
    return { ok: true, skipped: true, message: "Not an eBay order" };
  }
  if (seller !== EBAY_SELLING_USERNAME) {
    const message = "Skipped — not Open Box (ikonikdeals2026)";
    await mark(sb, order.id, {
      ebay_weight_sync_ok: false,
      ebay_weight_sync_error: message,
      ebay_weight_synced_at: new Date().toISOString(),
      ebay_weight_sync_via: null,
    });
    return { ok: false, skipped: true, message };
  }

  const weightLb = num(order.weight_verified_lb);
  if (!weightLb) {
    return { ok: false, message: "No verified weight on the order" };
  }

  const { data: unit } = await sb
    .from("units")
    .select("sku, package_length_in, package_width_in, package_height_in, package_weight_lb, product_weight_lb")
    .eq("store_id", storeId)
    .eq("sku", order.sku)
    .maybeSingle();

  // Sold single-qty listings are usually delisted — still revise package when eBay allows it.
  const { data: listingRows, error: listingErr } = await sb
    .from("listings")
    .select("listing_id, offer_id, status, sku, ebay_account_id, listed_at, delisted_at")
    .eq("store_id", storeId)
    .eq("channel", "ebay")
    .eq("sku", order.sku)
    .order("listed_at", { ascending: false })
    .limit(5);
  if (listingErr) console.log("ebay_weight_sync_listings", listingErr.message);
  const listing = (listingRows || []).find((row) => row.listing_id) || (listingRows || [])[0] || null;

  if (!listing?.listing_id && !order.sku) {
    const message = "No eBay listing found for this SKU";
    await mark(sb, order.id, {
      ebay_weight_sync_ok: false,
      ebay_weight_sync_error: message,
      ebay_weight_synced_at: new Date().toISOString(),
      ebay_weight_sync_via: null,
    });
    return { ok: false, message };
  }

  let account;
  try {
    account = await loadEbayAccount(storeId, { username: EBAY_SELLING_USERNAME });
    assertEbaySellerWrite(account);
  } catch (e) {
    const message = String(e?.message || e).slice(0, 240);
    await mark(sb, order.id, {
      ebay_weight_sync_ok: false,
      ebay_weight_sync_error: message,
      ebay_weight_synced_at: new Date().toISOString(),
      ebay_weight_sync_via: null,
    });
    return { ok: false, message };
  }

  let lengthIn = num(unit?.package_length_in);
  let widthIn = num(unit?.package_width_in);
  let heightIn = num(unit?.package_height_in);
  const listingId = listing?.listing_id ? String(listing.listing_id) : null;
  let listingStatus = listing?.status || "";

  let token = null;
  try {
    token = await userTokenForAccount(account);
  } catch (e) {
    const message = String(e?.message || e).slice(0, 240);
    await mark(sb, order.id, {
      ebay_weight_sync_ok: false,
      ebay_weight_sync_error: message,
      ebay_weight_synced_at: new Date().toISOString(),
      ebay_weight_sync_via: null,
    });
    return { ok: false, message };
  }

  if (listingId && !(lengthIn && widthIn && heightIn)) {
    try {
      const pkg = await getItemShippingPackage(token, listingId, account);
      listingStatus = pkg.listingStatus || listingStatus;
      if (pkg.box) {
        lengthIn = lengthIn || num(pkg.box.lengthIn);
        widthIn = widthIn || num(pkg.box.widthIn);
        heightIn = heightIn || num(pkg.box.heightIn);
      }
    } catch (e) {
      console.log("ebay_weight_sync_getitem_package", String(e?.message || e).slice(0, 160));
    }
  }

  const box = { lengthIn, widthIn, heightIn, weightLb };
  const hasDims = Boolean(lengthIn && widthIn && heightIn);
  const errors = [];
  const ended = /completed|ended/i.test(listingStatus || "");

  try {
    let via = null;
    let tradingEnded = ended;

    if (listingId && hasDims) {
      try {
        await reviseFixedPricePackage(token, { itemId: listingId, ...box }, account);
        via = "trading";
      } catch (err) {
        const message = String(err?.message || err);
        errors.push(`trading: ${message.slice(0, 180)}`);
        if (/ended listing|auction ended|cannot be revised|not allowed to revise ended/i.test(message)) {
          tradingEnded = true;
        }
        // Fall through to Inventory — inventory-based listings and SKU hygiene.
      }
    } else if (listingId && !hasDims) {
      errors.push("trading: skipped (no package dimensions on Floor or listing)");
    }

    if (!via) {
      try {
        const sku = encodeURIComponent(order.sku);
        const current = await ebayFetchAccount(account, "GET", `/sell/inventory/v1/inventory_item/${sku}`);
        const body = {
          ...current,
          packageWeightAndSize: {
            ...(current.packageWeightAndSize || {}),
            ...inventoryPackage(box),
          },
        };
        delete body.sku;
        await ebayFetchAccount(account, "PUT", `/sell/inventory/v1/inventory_item/${sku}`, body);
        via = "inventory";
      } catch (err) {
        const message = String(err?.message || err);
        errors.push(`inventory: ${message.slice(0, 180)}`);
      }
    }

    // Ended/sold single-qty listings: Trading refuses package revise, and Inventory
    // updates do not change the completed listing's ShippingPackageDetails that
    // Seller Hub's label screen reads. Surface that clearly — do not claim a label pre-fill win.
    if (tradingEnded && via !== "trading") {
      const message = via === "inventory"
        ? "eBay will not revise package weight on ended (sold) listings. Inventory SKU updated, but Seller Hub label still uses the sale-time weight."
        : (errors.join(" · ") || "eBay will not revise package weight on ended (sold) listings.");
      await mark(sb, order.id, {
        ebay_weight_sync_ok: false,
        ebay_weight_sync_error: message.slice(0, 280),
        ebay_weight_synced_at: new Date().toISOString(),
        ebay_weight_sync_via: via,
      });
      return { ok: false, via, listingId, listingStatus, message };
    }

    if (!via) {
      const message = errors.join(" · ") || "Could not update eBay package weight";
      await mark(sb, order.id, {
        ebay_weight_sync_ok: false,
        ebay_weight_sync_error: message.slice(0, 280),
        ebay_weight_synced_at: new Date().toISOString(),
        ebay_weight_sync_via: null,
      });
      return { ok: false, listingId, listingStatus, message };
    }

    await mark(sb, order.id, {
      ebay_weight_sync_ok: true,
      ebay_weight_sync_error: null,
      ebay_weight_synced_at: new Date().toISOString(),
      ebay_weight_sync_via: via,
    });
    return {
      ok: true,
      via,
      listingId,
      listingStatus,
      message: `Weight sent to eBay (${via})`,
    };
  } catch (err) {
    const message = String(err?.message || err).slice(0, 280);
    await mark(sb, order.id, {
      ebay_weight_sync_ok: false,
      ebay_weight_sync_error: message,
      ebay_weight_synced_at: new Date().toISOString(),
      ebay_weight_sync_via: null,
    });
    return { ok: false, listingId, listingStatus, message };
  }
}
