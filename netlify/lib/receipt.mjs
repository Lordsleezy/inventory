// Shared receipt rendering for emailed + website receipts.
// Same structure as apps/pos/src/receipt.ts so designer preview ≈ email.

export const DEFAULT_RECEIPT_LEGAL =
  "7-DAY EXCHANGE ONLY. No returns and no refunds. With this receipt, you may exchange the item or take store credit within 7 days of sale. Goods are sold AS-IS, WHERE-IS, with all faults, whether or not noted at sale. The seller is not the manufacturer and does not provide manufacturer warranty service unless a remaining OEM warranty still applies to that serial. Keep this receipt.";

export function money(cents) {
  const n = Number(cents) || 0;
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}

export function defaultBranding(storeName) {
  return {
    storeName: storeName || "Floor",
    address: "",
    phone: "",
    logoUrl: null,
    headerMessage: null,
    footerMessage: null,
    legal: DEFAULT_RECEIPT_LEGAL,
    returnPolicy: null,
    reviewUrl: null,
    showSku: true,
    showCondition: true,
    showClerk: true,
    showDiscount: true,
    showPoints: true,
    showTax: true,
    showTenderDetails: true,
  };
}

export function mergeBranding(stored, override, displayName) {
  const base = defaultBranding(displayName);
  const fromStore = stored && typeof stored === "object" ? stored : {};
  const merged = { ...base, ...fromStore, ...(override || {}) };
  if (!merged.storeName) merged.storeName = displayName || "Floor";
  return merged;
}

function escape(t) {
  return String(t || "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
}

function cardBits(first) {
  return [first?.card_brand, first?.card_last4 ? `•••• ${first.card_last4}` : null]
    .filter(Boolean)
    .join(" ");
}

function tenderLabel(first, extras) {
  const method = (first?.payment_method || "cash").toUpperCase();
  if (method === "SPLIT") {
    const parts = ["SPLIT"];
    if (extras?.cash_cents != null) parts.push(`cash ${money(extras.cash_cents)}`);
    parts.push(`${cardBits(first) || "card"} ${money(extras?.card_cents ?? 0)}`);
    return parts.join(" · ");
  }
  const bits = cardBits(first);
  const charged = extras?.card_cents;
  return `${method}${bits ? ` · ${bits}` : ""}${
    method === "CARD" && charged != null ? ` · ${money(charged)}` : ""
  }`;
}

function totals(sales, extras) {
  const subtotal = sales.reduce((s, r) => s + (r.price_cents || 0), 0);
  const tax = sales.reduce((s, r) => s + (r.tax_cents || 0), 0);
  const cardFee = sales.reduce((s, r) => s + (r.card_fee_cents || 0), 0) || (extras?.card_fee_cents || 0);
  const discount =
    (extras?.discount_cents || 0) + (extras?.signup_discount_cents || 0) ||
    sales.reduce((s, r) => {
      const list = r.list_price_cents;
      return list != null && list > r.price_cents ? s + (list - r.price_cents) : s;
    }, 0);
  return { subtotal, tax, cardFee, discount, total: subtotal + tax + cardFee };
}

export function buildReceiptText(sales, extras, branding, clerkName) {
  const first = sales[0];
  const receiptNo = first?.receipt_no || first?.ticket_id?.slice?.(0, 8) || "receipt";
  const soldAt = first?.sold_at ? new Date(first.sold_at).toLocaleString() : new Date().toLocaleString();
  const { subtotal, tax, cardFee, discount, total } = totals(sales, extras);
  const lines = [
    branding.storeName,
    branding.address,
    branding.phone,
    branding.headerMessage || "",
    "--------------------------------",
    `Date      ${soldAt}`,
    `Receipt   ${receiptNo}`,
    branding.showClerk !== false ? `Clerk     ${clerkName || first?.actor_name || ""}` : "",
    "--------------------------------",
  ];
  for (const s of sales) {
    if (branding.showSku !== false) lines.push(`SKU       ${s.sku}`);
    lines.push(s.title || "Item");
    if (branding.showCondition !== false && s.condition) lines.push(`Cond      ${s.condition}`);
    lines.push(`Price     ${money(s.price_cents)}`);
  }
  if (branding.showDiscount !== false && discount > 0) lines.push(`Discount  -${money(discount)}`);
  lines.push(`Subtotal  ${money(subtotal)}`);
  if (branding.showTax !== false) lines.push(`Tax       ${money(tax)}`);
  if (cardFee > 0) lines.push(`Card fee  ${money(cardFee)}`);
  lines.push(`TOTAL     ${money(total)}`);
  lines.push(`Tender    ${tenderLabel(first, extras)}`);
  if (branding.showPoints !== false && extras?.points_earned) lines.push(`Pts earned ${extras.points_earned}`);
  if (branding.showPoints !== false && extras?.points_redeemed) {
    lines.push(`Store cr. -${money(extras.points_redeemed)}`);
  }
  lines.push("--------------------------------");
  lines.push(branding.legal || "");
  if (branding.returnPolicy) lines.push(branding.returnPolicy);
  if (branding.footerMessage) lines.push(branding.footerMessage);
  if (branding.reviewUrl) lines.push(`Review: ${branding.reviewUrl}`);
  return lines.filter((l) => l !== "" && l != null).join("\n");
}

export function buildReceiptHtml(sales, extras, branding, clerkName) {
  const first = sales[0];
  const receiptNo = first?.receipt_no || "receipt";
  const soldAt = first?.sold_at ? new Date(first.sold_at).toLocaleString() : new Date().toLocaleString();
  const { subtotal, tax, cardFee, discount, total } = totals(sales, extras);
  const items = sales
    .map(
      (s) =>
        `<tr><td>${escape(s.title || "Item")}${
          branding.showSku !== false ? `<div style="color:#666;font-size:12px">${escape(s.sku)}</div>` : ""
        }${
          branding.showCondition !== false && s.condition
            ? `<div style="color:#666;font-size:12px">${escape(s.condition)}</div>`
            : ""
        }</td><td style="text-align:right">${escape(money(s.price_cents))}</td></tr>`,
    )
    .join("");
  const logo = branding.logoUrl
    ? `<img src="${escape(branding.logoUrl)}" alt="" style="max-height:64px;margin-bottom:8px" />`
    : "";
  const contact = [branding.address, branding.phone].filter(Boolean).map(escape).join("<br/>");
  const row = (label, cents) =>
    `<div style="display:flex;justify-content:space-between"><span>${escape(label)}</span><span>${escape(money(cents))}</span></div>`;
  return `<!doctype html><html><body style="font:14px/1.5 system-ui,sans-serif;color:#111;max-width:480px;margin:0 auto;padding:24px">
${logo}
<h1 style="margin:0;font-size:22px">${escape(branding.storeName)}</h1>
${contact ? `<p style="color:#555;margin:4px 0 16px">${contact}</p>` : ""}
${branding.headerMessage ? `<p>${escape(branding.headerMessage)}</p>` : ""}
<p style="color:#666;font-size:12px">Receipt ${escape(receiptNo)} · ${escape(soldAt)}${
    branding.showClerk !== false && (clerkName || first?.actor_name)
      ? ` · ${escape(clerkName || first?.actor_name)}`
      : ""
  }</p>
<table style="width:100%;border-collapse:collapse">${items}</table>
<div style="border-top:1px solid #ccc;margin-top:12px;padding-top:12px">
${discount > 0 && branding.showDiscount !== false ? row("Discount", -discount) : ""}
${row("Subtotal", subtotal)}
${branding.showTax !== false ? row("Sales tax", tax) : ""}
${cardFee > 0 ? row("Card fee", cardFee) : ""}
<div style="display:flex;justify-content:space-between;font-weight:700;font-size:18px"><span>Total</span><span>${escape(money(total))}</span></div>
<div style="display:flex;justify-content:space-between"><span>Tender</span><span>${escape(tenderLabel(first, extras))}</span></div>
${branding.showPoints !== false && extras?.points_earned ? `<div style="display:flex;justify-content:space-between"><span>Points earned</span><span>${extras.points_earned}</span></div>` : ""}
${branding.showPoints !== false && extras?.points_redeemed ? `<div style="display:flex;justify-content:space-between"><span>Store credit</span><span>-${escape(money(extras.points_redeemed))}</span></div>` : ""}
</div>
${branding.reviewUrl ? `<p style="margin-top:16px"><a href="${escape(branding.reviewUrl)}">Leave us a Google review</a></p>` : ""}
<p style="color:#555;font-size:12px;margin-top:20px">${escape(branding.legal || "")}</p>
${branding.returnPolicy ? `<p style="color:#555;font-size:12px">${escape(branding.returnPolicy)}</p>` : ""}
${branding.footerMessage ? `<p style="color:#555">${escape(branding.footerMessage)}</p>` : ""}
</body></html>`;
}

export async function sendResend({ to, subject, text, html, headers }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!key || !from || !to)
    return { skipped: true, reason: !key || !from ? "missing_resend_env" : "missing_to" };
  const body = { from, to: [to], subject, text };
  if (html) body.html = html;
  if (headers) body.headers = headers;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`resend ${res.status}: ${errBody}`);
  }
  return { ok: true };
}
