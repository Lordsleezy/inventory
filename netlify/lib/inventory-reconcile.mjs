/**
 * Find inventory that can be sold twice, and sold units that are still listed.
 * Pure shaping lives here so the scheduled function and tests share one definition.
 */

export function reconcileFindings({ units = [], sales = [], orders = [], listings = [] } = {}) {
  const soldSkus = new Set();
  for (const sale of sales) {
    if (!sale?.sku || sale.voided_at) continue;
    soldSkus.add(String(sale.sku));
  }
  for (const order of orders) {
    if (!order?.sku || order.sku === "UNMATCHED") continue;
    if (order.voided || order.status === "canceled" || order.status === "refunded") continue;
    soldSkus.add(String(order.sku));
  }

  const bySku = new Map(units.map((unit) => [String(unit.sku), unit]));
  const soldButAvailable = [];
  for (const sku of soldSkus) {
    const unit = bySku.get(sku);
    if (unit && unit.state === "available") {
      const sale = sales.find((row) => String(row.sku) === sku && !row.voided_at);
      const order = orders.find((row) => String(row.sku) === sku && row.status !== "canceled" && row.status !== "refunded");
      soldButAvailable.push({
        sku,
        title: unit.title || "",
        floor_state: unit.state,
        channel: sale?.channel || order?.channel || null,
        sold_at: sale?.sold_at || order?.paid_at || null,
        price_cents: sale?.price_cents ?? order?.item_cents ?? null,
      });
    }
  }

  const soldStillListed = [];
  for (const listing of listings) {
    if (listing?.status !== "listed") continue;
    const unit = bySku.get(String(listing.sku));
    if (!unit || unit.state !== "sold") continue;
    soldStillListed.push({
      sku: String(listing.sku),
      title: unit.title || "",
      floor_state: unit.state,
      channel: listing.channel,
      listing_id: listing.listing_id || null,
    });
  }

  soldButAvailable.sort((a, b) => a.sku.localeCompare(b.sku));
  soldStillListed.sort((a, b) => a.channel.localeCompare(b.channel) || a.sku.localeCompare(b.sku));
  return { soldButAvailable, soldStillListed };
}

export function reconcileAlertText(findings) {
  const lines = ["Floor reconciliation found units that can still be sold twice, or sold units still listed.", ""];
  if (findings.soldButAvailable.length) {
    lines.push("Sold on a channel but still Available in Floor:");
    for (const row of findings.soldButAvailable) {
      lines.push(`- ${row.sku} ${row.title} via ${row.channel || "unknown"} ${row.price_cents != null ? `$${(row.price_cents / 100).toFixed(2)}` : ""}`.trim());
    }
    lines.push("");
  }
  if (findings.soldStillListed.length) {
    lines.push("Marked sold in Floor but a listing row is still live:");
    for (const row of findings.soldStillListed) {
      lines.push(`- ${row.sku} ${row.title} on ${row.channel}${row.listing_id ? ` (${row.listing_id})` : ""}`);
    }
    lines.push("");
  }
  lines.push("eBay listings for sold units are ended by this job when the selling account allows it. Depop and Whatnot have no delist API; an open delist reminder was created for those.");
  return lines.join("\n");
}
