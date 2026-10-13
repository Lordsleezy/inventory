import { floorCloud, loadStoreSetting, type TicketSummary } from '@floor/cloud';
import { formatCentsTotal } from '@floor/store';

export type SalePhase = 'idle' | 'quoting' | 'manual_card' | 'finalizing';

export type RegisterSettings = {
  clerkMaxDiscountBps: number;
  rewardsEnabled: boolean;
  rewardsPointsPerDollar: number;
  rewardsPointValueCents: number;
  rewardsSignupDiscountBps: number;
  storeDisplayName: string;
  cardFeeBps: number;
};

export const DEFAULT_REGISTER_SETTINGS: RegisterSettings = {
  clerkMaxDiscountBps: 1000,
  rewardsEnabled: true,
  rewardsPointsPerDollar: 1,
  rewardsPointValueCents: 1,
  rewardsSignupDiscountBps: 500,
  storeDisplayName: 'Open Box Industries',
  cardFeeBps: 250,
};

export const RECEIPT_LEGAL =
  '7-DAY EXCHANGE ONLY. No returns and no refunds. With this receipt, you may exchange the item or take store credit within 7 days of sale. Goods are sold AS-IS, WHERE-IS, with all faults. Keep this receipt.';

function numSetting(raw: unknown, fallback: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'boolean') return raw ? 1 : 0;
  if (typeof raw === 'string') {
    const n = Number(raw.replace(/"/g, ''));
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

function boolSetting(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true' || raw === '"true"') return true;
  if (raw === 'false' || raw === '"false"') return false;
  return fallback;
}

function textSetting(raw: unknown, fallback: string): string {
  if (typeof raw === 'string') return raw.replace(/^"|"$/g, '') || fallback;
  if (raw != null && typeof raw !== 'object') return String(raw);
  return fallback;
}

export async function loadRegisterSettings(): Promise<RegisterSettings> {
  const d = DEFAULT_REGISTER_SETTINGS;
  const [maxDisc, enabled, perDollar, pointValue, signupBps, displayName, cardFee] = await Promise.all([
    loadStoreSetting('clerk_max_discount_bps'),
    loadStoreSetting('rewards_enabled'),
    loadStoreSetting('rewards_points_per_dollar'),
    loadStoreSetting('rewards_point_value_cents'),
    loadStoreSetting('rewards_signup_discount_bps'),
    loadStoreSetting('display_name'),
    loadStoreSetting('card_fee_bps'),
  ]);
  return {
    clerkMaxDiscountBps: numSetting(maxDisc, d.clerkMaxDiscountBps),
    rewardsEnabled: boolSetting(enabled, d.rewardsEnabled),
    rewardsPointsPerDollar: numSetting(perDollar, d.rewardsPointsPerDollar),
    rewardsPointValueCents: numSetting(pointValue, d.rewardsPointValueCents),
    rewardsSignupDiscountBps: numSetting(signupBps, d.rewardsSignupDiscountBps),
    storeDisplayName: textSetting(displayName, d.storeDisplayName),
    cardFeeBps: numSetting(cardFee, d.cardFeeBps),
  };
}

function functionsUrl(path: string): string {
  const base = String(
    import.meta.env.VITE_FUNCTIONS_URL || import.meta.env.VITE_FLOOR_FUNCTIONS_URL || 'https://inventoryobi.netlify.app',
  ).replace(/\/$/, '');
  return `${base}/.netlify/functions/${path}`;
}

async function callFunction(path: string, init: RequestInit = {}): Promise<Response> {
  const { data } = await floorCloud().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('not_signed_in');
  return fetch(functionsUrl(path), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}), Authorization: `Bearer ${token}` },
  });
}

export async function withdrawListingsAfterSale(skus: string[]): Promise<void> {
  for (const sku of skus) {
    try {
      await callFunction('ebay-withdraw', {
        method: 'POST',
        body: JSON.stringify({ afterSale: true, sku }),
      });
    } catch {
      // marketplace sync picks it up later
    }
  }
}

export type ReceiptMeta = {
  clerkName: string;
  storeName: string;
  changeCents: number | null;
  titles: Record<string, { title: string; condition: string | null }>;
  cashTenderedCents?: number | null;
  legal?: string;
  headerMessage?: string | null;
  footerMessage?: string | null;
  qrHeader?: string | null;
  qrCodeDataUrl?: string | null;
};

export type ReceiptPayload = {
  storeName: string;
  receiptNo: string;
  soldAt: string;
  clerkName: string;
  subtotalCents: number;
  discountCents: number | null;
  taxCents: number;
  cardFeeCents: number | null;
  totalCents: number;
  tender: string;
  cashTenderedCents: number | null;
  changeCents: number | null;
  pointsEarned: number | null;
  pointsRedeemed: number | null;
  pointsBalance: number | null;
  legal: string;
  headerMessage: string | null;
  footerMessage: string | null;
  qrHeader: string | null;
  qrCodeDataUrl: string | null;
  lines: { sku: string; title: string; condition: string | null; priceCents: number; qty: number }[];
};

export function ticketReceiptPayload(summary: TicketSummary, meta: ReceiptMeta): ReceiptPayload {
  const first = summary.lines[0];
  const method = (summary.payment_method || 'cash').toUpperCase();
  const cardBits = [summary.card_brand, summary.card_last4 ? `ΓÇóΓÇóΓÇóΓÇó ${summary.card_last4}` : null]
    .filter(Boolean)
    .join(' ');
  const tender =
    method +
    (cardBits ? ` ┬╖ ${cardBits}` : '') +
    (method === 'SPLIT' ? ` ┬╖ cash ${formatCentsTotal(summary.cash_cents ?? 0)} ┬╖ card ${formatCentsTotal(summary.card_cents ?? 0)}` : '') +
    (meta.changeCents != null ? ` ┬╖ change ${formatCentsTotal(meta.changeCents)}` : '');
  const lineDiscount = summary.lines.reduce((sum, l) => {
    const list = l.list_price_cents;
    return list != null && list > l.price_cents ? sum + (list - l.price_cents) : sum;
  }, 0);
  const discountCents =
    (summary.discount_cents ?? 0) + (summary.signup_discount_cents ?? 0) || (lineDiscount > 0 ? lineDiscount : null);
  return {
    storeName: meta.storeName,
    receiptNo: first?.receipt_no || summary.ticket_id.slice(0, 8),
    soldAt: new Date().toLocaleString(),
    clerkName: meta.clerkName,
    subtotalCents: summary.subtotal_cents,
    discountCents: discountCents && discountCents > 0 ? discountCents : null,
    taxCents: summary.tax_cents,
    cardFeeCents: summary.card_fee_cents ?? null,
    totalCents: summary.total_cents,
    tender,
    cashTenderedCents: meta.cashTenderedCents ?? summary.amount_tendered_cents ?? null,
    changeCents: meta.changeCents,
    pointsEarned: summary.points_earned ?? null,
    pointsRedeemed: summary.points_redeemed ?? null,
    pointsBalance: summary.points_balance ?? summary.customer?.points_balance ?? null,
    legal: meta.legal ?? RECEIPT_LEGAL,
    headerMessage: meta.headerMessage ?? null,
    footerMessage: meta.footerMessage ?? null,
    qrHeader: meta.qrHeader ?? null,
    qrCodeDataUrl: meta.qrCodeDataUrl ?? null,
    lines: summary.lines.map(l => ({
      sku: l.sku,
      title: meta.titles[l.sku]?.title || 'Item',
      condition: meta.titles[l.sku]?.condition ?? null,
      priceCents: l.price_cents,
      qty: l.qty ?? 1,
    })),
  };
}

const esc = (t: string) =>
  String(t || '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

export function receiptHtml(r: ReceiptPayload): string {
  const items = r.lines
    .map(
      l =>
        `<tr><td><strong>${esc((l.qty > 1 ? `${l.qty}├ù ` : '') + l.title)}</strong><div style="color:#666;font-size:12px">SKU ${esc(l.sku)}${l.condition ? ` ┬╖ ${esc(l.condition)}` : ''}</div></td><td style="text-align:right">${esc(formatCentsTotal(l.priceCents))}</td></tr>`,
    )
    .join('');
  const line = (label: string, value: string, bold = false) =>
    `<div style="display:flex;justify-content:space-between${bold ? ';font-weight:700;font-size:18px;margin-top:4px' : ''}"><span>${esc(label)}</span><span>${esc(value)}</span></div>`;
  const totals = [
    line('Subtotal', formatCentsTotal(r.subtotalCents)),
    r.discountCents ? line('Discount', `ΓêÆ${formatCentsTotal(r.discountCents)}`) : '',
    r.taxCents > 0 ? line('Sales tax', formatCentsTotal(r.taxCents)) : '',
    r.cardFeeCents ? line('Card surcharge', formatCentsTotal(r.cardFeeCents)) : '',
    line('Total', formatCentsTotal(r.totalCents), true),
    r.cashTenderedCents != null && r.changeCents != null ? line('Cash tendered', formatCentsTotal(r.cashTenderedCents)) : '',
    r.changeCents != null ? line('Change', formatCentsTotal(r.changeCents)) : '',
    r.pointsRedeemed ? line('Points redeemed', String(r.pointsRedeemed)) : '',
    r.pointsEarned ? line('Points earned', String(r.pointsEarned)) : '',
    r.pointsBalance != null ? line('Points balance', String(r.pointsBalance)) : '',
    line('Paid', r.tender),
  ]
    .filter(Boolean)
    .join('');
  const qrSrc =
    r.qrCodeDataUrl && /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(r.qrCodeDataUrl) ? r.qrCodeDataUrl : '';
  const qrBlock = qrSrc
    ? `<div class="qr">${r.qrHeader ? `<div class="qr-head">${esc(r.qrHeader)}</div>` : ''}<img src="${qrSrc}" alt="QR code"/></div>`
    : '';
  return `<!doctype html><html><head><title>Receipt ${esc(r.receiptNo)}</title>
<style>body{font:14px/1.45 system-ui,sans-serif;color:#111;max-width:480px;margin:24px auto;padding:0 16px}
h1{margin:0;font-size:22px}.muted{color:#666;font-size:12px}table{width:100%;border-collapse:collapse;margin-top:8px}
td{padding:6px 0;vertical-align:top}.box{border-top:1px solid #ccc;margin-top:14px;padding-top:12px;display:grid;gap:4px}
.legal{color:#555;font-size:12px;margin-top:22px;white-space:pre-wrap}.foot{color:#555;font-size:12px;margin-top:12px;text-align:center}
.qr{margin-top:18px;text-align:center}.qr-head{font-size:13px;margin-bottom:8px}.qr img{width:140px;height:140px;object-fit:contain}</style></head><body>
<h1>${esc(r.storeName)}</h1>
${r.headerMessage ? `<p class="muted">${esc(r.headerMessage)}</p>` : ''}
<p class="muted">Receipt ${esc(r.receiptNo)} ┬╖ ${esc(r.soldAt)}<br/>In person ┬╖ ${esc(r.clerkName)}</p>
<table>${items}</table><div class="box">${totals}</div>
${r.footerMessage ? `<p class="foot">${esc(r.footerMessage)}</p>` : ''}
<p class="legal">${esc(r.legal)}</p>
${qrBlock}
<script>window.onload=function(){window.print();}</script>
</body></html>`;
}

export function receiptText(r: ReceiptPayload): string {
  const width = 40;
  const pair = (label: string, value: string) => label + value.padStart(Math.max(1, width - label.length));
  const rows = [
    r.storeName,
    `Receipt ${r.receiptNo}`,
    `${r.soldAt} ┬╖ ${r.clerkName}`,
    '-'.repeat(width),
    ...r.lines.flatMap(l => [
      pair((l.qty > 1 ? `${l.qty}x ` : '') + l.title, formatCentsTotal(l.priceCents)),
      `  SKU ${l.sku}${l.condition ? ` ┬╖ ${l.condition}` : ''}`,
    ]),
    '-'.repeat(width),
    pair('Subtotal', formatCentsTotal(r.subtotalCents)),
    ...(r.discountCents ? [pair('Discount', `-${formatCentsTotal(r.discountCents)}`)] : []),
    ...(r.taxCents > 0 ? [pair('Sales tax', formatCentsTotal(r.taxCents))] : []),
    ...(r.cardFeeCents ? [pair('Card surcharge', formatCentsTotal(r.cardFeeCents))] : []),
    pair('TOTAL', formatCentsTotal(r.totalCents)),
    ...(r.changeCents != null ? [pair('Change', formatCentsTotal(r.changeCents))] : []),
    `Paid: ${r.tender}`,
    '',
    r.legal,
  ];
  return rows.join('\n') + '\n';
}

export function printReceiptHtml(html: string): boolean {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument || iframe.contentWindow?.document;
  if (!doc) {
    document.body.removeChild(iframe);
    return false;
  }
  doc.open();
  doc.write(html);
  doc.close();
  setTimeout(() => {
    try {
      document.body.removeChild(iframe);
    } catch {
      // already removed
    }
  }, 60_000);
  return true;
}

export function downloadReceiptText(r: ReceiptPayload): void {
  const blob = new Blob([receiptText(r)], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `receipt-${r.receiptNo}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
