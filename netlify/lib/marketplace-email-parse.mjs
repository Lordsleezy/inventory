import { createHash } from 'node:crypto';

/**
 * Shared marketplace sale-email parsing + ingest.
 * Used by:
 *  - netlify/functions/marketplace-email.mjs  (raw email POSTed by a forwarder)
 *  - netlify/functions/gmail-sales-poll.mjs   (IMAP inbox reader)
 *
 * Whatnot is intentionally not a default channel any more. Stores can still add
 * it back through the "marketplace_channels" store setting.
 */

export const defaultChannels = [
  { key: 'ebay', aliases: ['ebay', 'e bay'] },
  { key: 'mercari', aliases: ['mercari'] },
  { key: 'poshmark', aliases: ['poshmark'] },
  { key: 'facebook', aliases: ['facebook marketplace', 'facebook', 'meta'] },
  { key: 'depop', aliases: ['depop'] },
  { key: 'etsy', aliases: ['etsy'] },
  { key: 'grailed', aliases: ['grailed'] },
  { key: 'vinted', aliases: ['vinted'] },
  { key: 'vestiaire_collective', aliases: ['vestiaire collective', 'vestiaire'] },
  { key: 'shopify', aliases: ['shopify'] },
  { key: 'vendoo', aliases: ['vendoo'] },
  { key: 'other', aliases: [] },
];

export const marketplaceOf = (s, channels = defaultChannels) => {
  const text = String(s).toLowerCase();
  const ordered = [...channels]
    .filter((x) => x.key !== 'other' && x.key !== 'vendoo')
    .sort((a, b) => Math.max(...(b.aliases || []).map((v) => v.length), 0) - Math.max(...(a.aliases || []).map((v) => v.length), 0));
  for (const c of ordered) if ((c.aliases || []).some((a) => a && text.includes(a.toLowerCase()))) return c.key;
  if (channels.some((x) => x.key === 'vendoo') && /vendoo/.test(text)) return 'vendoo';
  return 'other';
};

export const safeDate = (s) => {
  const d = new Date(s);
  return Number.isNaN(+d) ? null : d.toISOString().slice(0, 10);
};

/**
 * Extract Authentication-Results / ARC-Authentication-Results header blocks from raw RFC822.
 * Only the header section is inspected (fail closed if missing).
 */
export function authResultBlocks(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
  const cut = text.search(/\r?\n\r?\n/);
  const headerSection = (cut >= 0 ? text.slice(0, cut) : text).replace(/\r\n[ \t]+/g, ' ').replace(/\n[ \t]+/g, ' ');
  const blocks = [];
  const re = /^(?:ARC-)?Authentication-Results\s*:\s*(.+)$/gim;
  let m;
  while ((m = re.exec(headerSection))) blocks.push(m[1]);
  return blocks;
}

/**
 * True only when a receiver recorded dkim=pass for a Depop/Mercari signing domain.
 * From-header spoofing alone is not enough — a stranger emailing obitracking a fake
 * "You've made a sale" must not mark inventory sold. Gmail filter forwards from pgg124
 * are accepted when Google preserves ARC/Authentication-Results with the original DKIM.
 */
export function marketplaceDkimPassed(raw, domains = ['depop.com', 'mercari.com']) {
  const allowed = (domains || []).map((d) => String(d).toLowerCase().replace(/^@/, '')).filter(Boolean);
  if (!allowed.length) return false;
  const domainOk = (host) => {
    const h = String(host || '').toLowerCase().replace(/^@/, '');
    return allowed.some((d) => h === d || h.endsWith(`.${d}`));
  };
  for (const block of authResultBlocks(raw)) {
    if (!/dkim\s*=\s*pass\b/i.test(block)) continue;
    const hosts = [...block.matchAll(/\bheader\.(?:i|d)\s*=\s*@?([A-Za-z0-9.-]+)/gi)].map((x) => x[1]);
    if (hosts.some(domainOk)) return true;
  }
  return false;
}

/** IMAP/webhook gate: marketplace DKIM (or ARC-preserved DKIM) must pass. */
export function mailAuthenticatedForMarketplace(raw, domains = ['depop.com', 'mercari.com']) {
  return marketplaceDkimPassed(raw, domains);
}

const SALE_SIGNAL =
  /sold|you(?:'ve| have) made a sale|sale confirmation|shipping label and sale confirmation|order (?:confirmed|placed|complete|completed)|your item has sold|transaction (?:complete|completed)|payment received|item sold/i;

/** Strong sale confirmation phrases that beat offer/ship-reminder wording in the same email. */
const STRONG_SALE =
  /you(?:'ve| have) made a sale|shipping label and sale confirmation|sale confirmation|your item has sold|item sold(?:\s+for)?|payment received/i;

/**
 * Noise we must not treat as a sale (offers, reminders, auth).
 * Auth / "sign in" / "verify your" wording is subject-only — real Depop/Mercari sale
 * emails put those phrases in footers and must still ingest.
 */
export function isMarketplaceNoise(subject, text) {
  const subj = String(subject || '');
  const body = String(text || '');
  const combined = `${subj}\n${body}`;

  if (/security alert|password reset|verify your (?:email|account)|confirm your email|new login|sign[\s-]?in attempt/i.test(subj)) {
    return true;
  }
  if (/^(?:login|sign[\s-]?in)\b/i.test(subj.trim())) return true;

  // Offers: never a sale notice (even if the word "sold" appears elsewhere).
  if (
    /counter[\s-]?offer|you(?:'ve| have) received an offer|\bnew offer\b|offer (?:received|expir|accepted|declined)/i.test(
      combined,
    )
  ) {
    return true;
  }

  // Ship reminders: subject-driven only. Sale confirmations often say "ship soon".
  if (/^(?:time to ship|ship(?:ping)? reminder|you still need to ship)\b/i.test(subj.trim()) || /\b(?:time to ship|ship(?:ping)? reminder)\b/i.test(subj)) {
    return true;
  }

  // Listing removals / policy mail — not sales (body may still say "sold").
  if (/we(?:'ve| have) removed your listing|listing removed|listing (?:was )?taken down|community guidelines/i.test(subj)) {
    return true;
  }

  return false;
}

export function looksLikeSaleNotice(subject, text) {
  const s = `${subject || ''}\n${text || ''}`;
  const subj = String(subject || '');
  // Auth / security subjects are never sales, even if the body mentions "sold".
  if (/security alert|password reset|verify your (?:email|account)|confirm your email|new login|sign[\s-]?in attempt/i.test(subj)) {
    return false;
  }
  if (/^(?:login|sign[\s-]?in)\b/i.test(subj.trim())) return false;
  if (/we(?:'ve| have) removed your listing|you still need to ship/i.test(subj)) return false;
  if (!SALE_SIGNAL.test(s)) return false;
  if (isMarketplaceNoise(subject, text)) {
    // A clear sale confirmation wins over a subject that looks like a ship reminder.
    return STRONG_SALE.test(s);
  }
  return true;
}

const ORDER_ID_STOP = new Set(
  'details detail bottom confirmation number confirm shipping label item sale order transaction receipt view more here click'.split(
    ' ',
  ),
);

export function cleanOrderId(raw) {
  const v = String(raw || '').trim();
  if (!v || v.length < 5 || v.length > 40) return null;
  if (ORDER_ID_STOP.has(v.toLowerCase())) return null;
  if (!/[0-9]/.test(v) && !/^[A-Z]{2,}-/i.test(v)) return null;
  return v;
}

/** Stable Orders payment key when Depop/Mercari omit a real order id. */
export function marketplaceOrderKey({ orderNumber, messageId }) {
  const cleaned = cleanOrderId(orderNumber);
  if (cleaned) return cleaned;
  const msg = String(messageId || '').replace(/[<>\s]/g, '').replace(/[^A-Za-z0-9_-]/g, '');
  return `msg:${msg.slice(0, 48) || 'unknown'}`;
}

/** Undo quoted-printable soft breaks / =XX so CDN URLs in .eml / MIME bodies stay intact. */
export function decodeQuotedPrintableLight(input) {
  return String(input || '')
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Depop sale emails embed listing photos as:
 *   https://media-photos.depop.com/b1/{userId}/{photoId}_{hash}/P0.jpg
 * The photoId (digits before the underscore) is stable enough for exact SKU matching.
 * Tolerates quoted-printable soft-wrapped MIME (…4955799=\\n423_…).
 */
export function extractDepopPhotoIds(text) {
  const ids = new Set();
  const src = decodeQuotedPrintableLight(text);
  for (const m of src.matchAll(/media-photos\.depop\.com\/b\d+\/\d+\/(\d+)_[0-9a-f]+\//gi)) {
    if (m[1]) ids.add(m[1]);
  }
  // Soft-wrap fallback if decode missed a boundary.
  for (const m of src.matchAll(/media-photos\.depop\.com\/b\d+\/\d+\/(\d{6,})/gi)) {
    if (m[1]) ids.add(m[1]);
  }
  return [...ids];
}

/** Prefer "SKU ##### ·" at the start of a description line (Depop truncated first line). */
export function extractSkuFirstLine(text) {
  const src = String(text || '');
  return (
    src.match(/(?:^|[\r\n])\s*SKU\s*[:#-]?\s*(\d{5})\s*[·•|,\-]/i)?.[1] ||
    src.match(/(?:^|[\r\n])\s*SKU\s*[:#-]?\s*(\d{5})\b/i)?.[1] ||
    null
  );
}

export function parseMail(mail, channels = defaultChannels) {
  const rawHtml = decodeQuotedPrintableLight(mail.html || '');
  const rawText = decodeQuotedPrintableLight(mail.text || '');
  const text = [mail.subject, rawText, rawHtml].join('\n').replace(/<[^>]*>/g, ' ');
  const sender = mail.from?.address || '';
  const marketplace = marketplaceOf(`${sender} ${mail.subject} ${text.slice(0, 2000)}`, channels);
  const sale = looksLikeSaleNotice(mail.subject, text);
  // Prefer raw MIME (before tag strip) so photo URLs in <img src> survive.
  const photo_ids = extractDepopPhotoIds(`${mail.text || ''}\n${mail.html || ''}\n${rawText}\n${rawHtml}`);
  const sku =
    extractSkuFirstLine(text) ||
    text.match(/\bSKU\s*[:#-]?\s*(\d{5})\b/i)?.[1] ||
    // Vendoo / internal subjects often end with (11412)
    String(mail.subject || '').match(/\((\d{5})\)\s*$/)?.[1] ||
    // Depop/Mercari listing bodies sometimes bury "SKU 11412" without a colon.
    text.match(/\bSKU\s+(\d{5})\b/i)?.[1] ||
    null;
  const priceMatch =
    text.match(
      /(?:sold\s+for|sale\s+price|item\s+price|item\s+subtotal|you(?:'ve| have) made a sale!?|total\s+(?:sale\s+)?price)\D{0,40}\$\s?([0-9]{1,6}(?:\.[0-9]{2})?)/i,
    ) ||
    text.match(/\$\s?([0-9]{1,6}(?:\.[0-9]{2})?)\s*(?:sold|sale price|item price)/i) ||
    String(mail.subject || '').match(/\$\s?([0-9]{1,6}(?:\.[0-9]{2})?)/);
  const price = priceMatch ? Math.round(Number(priceMatch[1]) * 100) : null;
  // Require number/#/id after "sale" so "sale confirmation" is not an order id.
  const order = cleanOrderId(
    text.match(/(?:order|transaction)\s*(?:number|#|no\.?|id)\s*[:#-]?\s*([A-Z0-9-]{5,40})/i)?.[1] ||
      text.match(/sale\s*(?:number|#|no\.?|id)\s*[:#-]?\s*([A-Z0-9-]{5,40})/i)?.[1] ||
      null,
  );
  const ship = text.match(
    /(?:ship(?:ped)? by|ship before|ship no later than|ship by date)\s*[:\-]?\s*([A-Z][a-z]+\s+\d{1,2}(?:,\s*\d{4})?)/i,
  )?.[1];
  const rawHandle =
    String(mail.subject || '').match(/@([A-Za-z0-9._]{2,40})/)?.[1] ||
    text.match(/\bbuyer\s*[:@]\s*@?([A-Za-z0-9._]{2,40})/i)?.[1] ||
    null;
  // Subjects often end with "@buyer." — strip trailing punctuation from the capture.
  const handle = rawHandle ? rawHandle.replace(/[._]+$/g, '') || null : null;
  const name = text.match(/(?:ship to|shipping name|recipient)\s*[:\-]\s*([^\r\n]+)/i)?.[1] || null;
  const street =
    text.match(/\b\d{1,6}\s+[A-Za-z0-9.'# -]{3,70}\s(?:St|Street|Rd|Road|Ave|Avenue|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct)\.?\b/i)?.[0] ||
    null;
  const cityMatch = text.match(/([A-Za-z .'-]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)/);
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || null;
  const phone = text.match(/(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}/)?.[0] || null;
  const buyer = {
    ...(handle ? { name: `@${handle}`, handle } : {}),
    ...(name ? { name: name.trim() } : {}),
    ...(street ? { line1: street } : {}),
    ...(cityMatch ? { city: cityMatch[1].trim(), region: cityMatch[2], postal: cityMatch[3], country: 'US' } : {}),
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
  };
  // Prefer a real listing title over the Depop shipping-label subject.
  // Real Depop US sale emails put a truncated description first line under "Order details"
  // (e.g. "Pyrex glass mixing bowls See photos for...") — not labeled as Item/Listing.
  const subject = String(mail.subject || '').trim();
  const orderDetailsTitle = (() => {
    const m = text.match(/Order details[\s\S]{0,500}?([A-Za-z0-9][^\r\n$]{3,120}?)\s*(?:See photos|\$\s?\d)/i);
    if (!m?.[1]) return null;
    return m[1]
      .replace(/^(?:image|img|photo)\s+/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  })();
  const bodyTitle =
    text.match(/(?:item(?:\s+title)?|listing(?:\s+title)?|product)\s*[:\-]\s*([^\r\n]{4,120})/i)?.[1] ||
    text.match(/you(?:'ve| have) made a sale[:\s]+([^\r\n$]{4,120})/i)?.[1] ||
    orderDetailsTitle ||
    null;
  let item_title = (bodyTitle || subject || 'Marketplace order').replace(/\s+/g, ' ').trim().slice(0, 250);
  if (/shipping label and sale confirmation/i.test(item_title) && handle) {
    item_title = `Depop sale for @${handle}`;
  } else if (/shipping label and sale confirmation/i.test(item_title)) {
    item_title = 'Depop sale';
  }
  const fulfillment = /local pickup|buyer will pick up|pickup order/i.test(text) ? 'pickup' : 'ship';
  const money = (re) => {
    const m = text.match(re);
    return m ? Math.round(Number(m[1]) * 100) : null;
  };
  const fee = money(
    /(?:selling|transaction|processing|marketplace|final value|platform)\s*(?:fee|commission)[^\d$]{0,30}\$\s?([0-9]{1,6}(?:\.[0-9]{2})?)/i,
  );
  const shipLabel =
    money(/(?:prepaid\s+|shipping\s+)label[^\d$]{0,30}\$\s?([0-9]{1,6}(?:\.[0-9]{2})?)/i) ||
    money(/label\s+cost[^\d$]{0,30}\$\s?([0-9]{1,6}(?:\.[0-9]{2})?)/i);
  const tax = money(/(?:sales|buyer[\s-]?paid|order)\s*tax[^\d$]{0,30}\$\s?([0-9]{1,6}(?:\.[0-9]{2})?)/i);
  const payout = money(
    /(?:earnings|payout|net proceeds|you(?:'ll| will) (?:receive|earn)|take[\s-]?home)[^\d$]{0,30}\$\s?([0-9]{1,6}(?:\.[0-9]{2})?)/i,
  );
  return {
    text,
    marketplace,
    sale,
    sku,
    photo_ids,
    price,
    order_number: order,
    ship_by: ship ? safeDate(ship) : null,
    item_title,
    buyer,
    fulfillment,
    fee,
    ship_label: shipLabel,
    tax,
    payout,
  };
}

/**
 * Resolve Floor SKU without guessing:
 *  1) exact Depop photo-id → listed available unit
 *  2) explicit SKU in email (already on `parsed.sku`)
 *  3) exact Vendoo-sold photo-id fallback
 * Ambiguous / empty → null (Orders stays Needs SKU match).
 */
export async function resolveMarketplaceSku(sb, { storeId, marketplace, sku, photoIds }) {
  const channel = String(marketplace || '').toLowerCase();
  const photos = Array.isArray(photoIds) ? photoIds.filter((x) => /^\d{6,}$/.test(String(x))) : [];

  if (photos.length && (channel === 'depop' || channel === 'mercari')) {
    const { data: byPhoto, error } = await sb.rpc('match_listing_sku_by_photo', {
      p_store: storeId,
      p_channel: channel,
      p_photo_ids: photos,
    });
    if (error) throw error;
    if (byPhoto) return { sku: String(byPhoto), via: 'photo' };
  }

  const explicit = String(sku || '').match(/^\d{5}$/)?.[0] || null;
  if (explicit) return { sku: explicit, via: 'sku' };

  if (photos.length && (channel === 'depop' || channel === 'mercari')) {
    const { data: bySold, error } = await sb.rpc('match_vendoo_sold_sku_by_photo', {
      p_store: storeId,
      p_channel: channel,
      p_photo_ids: photos,
    });
    if (error) throw error;
    if (bySold) return { sku: String(bySold), via: 'vendoo_sold' };
  }

  return { sku: null, via: null };
}

export async function geminiEmailHints(text) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: `Extract only these fields from this marketplace sale email: sku (5-digit Floor SKU if explicitly present), item_title, order_number, ship_by (YYYY-MM-DD or null), buyer_name, buyer_email, buyer_phone, ship_line1, ship_line2, ship_city, ship_region, ship_postal, ship_country. Return JSON only. Do not invent a SKU. Do not infer missing values. Email:\n${text.slice(0, 14000)}`,
              },
            ],
          },
        ],
        generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 300, temperature: 0 },
      }),
    },
  );
  if (!res.ok) throw new Error(`Gemini email parse ${res.status}`);
  const data = await res.json();
  return JSON.parse(data.candidates?.[0]?.content?.parts?.[0]?.text || '{}');
}

/** Load the store id and its configured marketplace channels (falls back to defaults). */
export async function loadStoreChannels(sb) {
  const { data: store } = await sb.from('stores').select('id').limit(1).single();
  if (!store) throw new Error('store_missing');
  const { data: channelRow } = await sb
    .from('store_settings')
    .select('value')
    .eq('store_id', store.id)
    .eq('key', 'marketplace_channels')
    .maybeSingle();
  const channels = Array.isArray(channelRow?.value) ? channelRow.value : defaultChannels;
  return { store, channels };
}

export function messageIdFor(parsed, raw) {
  return parsed.messageId || createHash('sha256').update(raw).digest('hex');
}


/** Score available units listed on a channel against a sale title/price. */
export async function suggestSkuMatches(sb, { storeId, channel, title, priceCents, limit = 5 }) {
  const { data: units } = await sb
    .from('units')
    .select('sku,title,brand,model,ask_cents,listed_on,state')
    .eq('store_id', storeId)
    .eq('state', 'available')
    .contains('listed_on', [channel])
    .limit(250);
  const words = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !['the', 'and', 'for', 'with', 'pack', 'open', 'box', 'sale', 'depop', 'mercari', 'your', 'usps', 'shipping', 'label', 'confirmation'].includes(w));
  const scored = [];
  for (const u of units || []) {
    const t = `${u.title || ''} ${u.brand || ''} ${u.model || ''}`.toLowerCase().trim();
    if (!t) continue;
    let score = 0;
    for (const w of words) if (t.includes(w)) score += w.length > 4 ? 2 : 1;
    // Price alone must never win — require at least one title/brand/model token.
    if (score === 0) continue;
    if (priceCents != null && u.ask_cents != null) {
      const diff = Math.abs(Number(u.ask_cents) - Number(priceCents));
      if (diff === 0) score += 5;
      else if (diff <= 100) score += 3;
      else if (diff <= 500) score += 1;
      else score -= 1;
    }
    if (score > 0) scored.push({ sku: u.sku, title: u.title, ask_cents: u.ask_cents, score });
  }
  scored.sort((a, b) => b.score - a.score || a.sku.localeCompare(b.sku));
  return scored.slice(0, limit);
}

/**
 * Always put a detected marketplace sale into Orders (web_orders), even without a SKU.
 * Uses match_status=unmatched + sku=UNMATCHED so the Orders tab Link SKU flow works.
 */
export async function ensureUnmatchedWebOrder(sb, {
  storeId,
  marketplace,
  messageId,
  orderNumber,
  itemTitle,
  priceCents,
  shipBy,
  fulfillment,
  buyer,
  paidAt,
}) {
  const channel = String(marketplace || 'other').toLowerCase();
  const orderKey = marketplaceOrderKey({ orderNumber, messageId });
  const paymentId = `marketplace:${channel}:${orderKey}`;
  const { data: existing } = await sb
    .from('web_orders')
    .select('id,match_status,sku')
    .eq('store_id', storeId)
    .eq('payment_id', paymentId)
    .maybeSingle();
  if (existing) return { id: existing.id, created: false };

  const orderNo = `${channel.toUpperCase()}-${String(orderKey).replace(/[^A-Za-z0-9-]/g, '').slice(0, 28)}`.slice(0, 40);
  const cents = Number.isFinite(Number(priceCents)) && Number(priceCents) > 0 ? Math.round(Number(priceCents)) : 0;
  const paidIso = paidAt && !Number.isNaN(+new Date(paidAt)) ? new Date(paidAt).toISOString() : new Date().toISOString();
  const { data, error } = await sb
    .from('web_orders')
    .insert({
      store_id: storeId,
      sku: 'UNMATCHED',
      sale_id: null,
      status: 'paid',
      channel,
      fulfillment: fulfillment === 'pickup' ? 'pickup' : 'ship',
      order_no: orderNo,
      paid_at: paidIso,
      buyer_name: buyer?.name || (buyer?.handle ? `@${buyer.handle}` : null),
      buyer_email: buyer?.email || null,
      buyer_phone: buyer?.phone || null,
      ship_line1: buyer?.line1 || null,
      ship_line2: buyer?.line2 || null,
      ship_city: buyer?.city || null,
      ship_region: buyer?.region || null,
      ship_postal: buyer?.postal || null,
      ship_country: buyer?.country || 'US',
      item_cents: cents,
      shipping_cents: 0,
      tax_cents: 0,
      total_cents: cents,
      payment_id: paymentId,
      payment_env: 'production',
      ship_by: shipBy || null,
      match_status: 'unmatched',
      marketplace_title: String(itemTitle || `${channel} sale`).slice(0, 250),
      created_at: paidIso,
    })
    .select('id')
    .maybeSingle();
  if (error) {
    // Unique race / duplicate order_no — treat as already present.
    if (/duplicate|23505/i.test(error.message)) {
      const again = await sb.from('web_orders').select('id').eq('store_id', storeId).eq('payment_id', paymentId).maybeSingle();
      return { id: again.data?.id || null, created: false };
    }
    throw error;
  }

  await sb.from('channel_orders').upsert(
    {
      store_id: storeId,
      provider: channel,
      order_id: orderKey,
      sku: 'UNMATCHED',
      sale_id: null,
      item_cents: cents,
    },
    { onConflict: 'store_id,provider,order_id' },
  );

  return { id: data?.id || null, created: true };
}

/**
 * Parse one already-decoded email (PostalMime result) and run the same ingest path for every source:
 *   sale + exact SKU + price + available unit -> marketplace_ingest_sale
 *   anything else that looks like a sale     -> marketplace_email_sales (needs_review)
 *   non-sale mail                            -> marketplace_email_sales (ignored)
 * Returns { state: 'matched' | 'needs_review' | 'ignored' | 'duplicate', ... }. Throws on database errors
 * so pollers can leave the message unread and retry.
 *
 * Previously-ignored rows and unmatched needs_review rows for the same Message-ID are deleted
 * and re-evaluated so a parser fix (or INCLUDE_SEEN rescan) can recover sales that were wrongly
 * discarded or lacked a SKU on the first pass.
 */
export async function ingestMarketplaceMail(sb, { store, channels, parsed, raw }) {
  const p = parseMail(parsed, channels);
  if (
    p.sale &&
    (!p.sku || !p.buyer.line1 || !p.order_number || !p.ship_by) &&
    process.env.GEMINI_API_KEY
  ) {
    try {
      const hints = await geminiEmailHints(p.text);
      const hintSku = String(hints.sku || '').match(/\b(\d{5})\b/)?.[1];
      p.sku = p.sku || hintSku || null;
      p.item_title = hints.item_title || p.item_title;
      p.order_number = p.order_number || hints.order_number;
      p.ship_by = p.ship_by || hints.ship_by || null;
      p.buyer = {
        ...p.buyer,
        ...Object.fromEntries(
          Object.entries({
            name: hints.buyer_name,
            email: hints.buyer_email,
            phone: hints.buyer_phone,
            line1: hints.ship_line1,
            line2: hints.ship_line2,
            city: hints.ship_city,
            region: hints.ship_region,
            postal: hints.ship_postal,
            country: hints.ship_country,
          }).filter(([, v]) => v),
        ),
      };
    } catch {
      /* hints are optional */
    }
  }
  const msg = messageIdFor(parsed, raw);
  const orderKeyEarly = marketplaceOrderKey({ orderNumber: p.order_number, messageId: msg });
  const paymentIdEarly = `marketplace:${String(p.marketplace || 'other').toLowerCase()}:${orderKeyEarly}`;
  const { data: exists } = await sb
    .from('marketplace_email_sales')
    .select('id,state,sale_id')
    .eq('store_id', store.id)
    .eq('message_id', msg)
    .maybeSingle();
  if (exists) {
    // Never reopen a row that already finalized a sale.
    if (exists.sale_id) return { state: 'duplicate', sale_id: exists.sale_id };

    // If this sale is already in Orders, do not delete/recreate the email row on
    // INCLUDE_SEEN rescans (that churned ids and risked duplicate payment_ids).
    if (exists.state === 'needs_review') {
      const { data: wo } = await sb
        .from('web_orders')
        .select('id,match_status')
        .eq('store_id', store.id)
        .eq('payment_id', paymentIdEarly)
        .maybeSingle();
      if (wo) {
        // Only re-open when we newly have an exact SKU to finalize.
        if (!(p.sale && p.sku && p.price)) {
          return { state: 'needs_review', web_order_id: wo.id, order_created: false, stable: true };
        }
      }
    }

    // Re-evaluate ignored mail (and needs_review without an Orders row) so parser
    // fixes / Gemini SKU hints can recover sales.
    if (!exists.sale_id && (exists.state === 'ignored' || exists.state === 'needs_review')) {
      const { error: delErr } = await sb.from('marketplace_email_sales').delete().eq('id', exists.id);
      if (delErr) throw delErr;
    } else {
      return { state: 'duplicate' };
    }
  }

  if (!p.sale) {
    const { error } = await sb.from('marketplace_email_sales').insert({
      store_id: store.id,
      message_id: msg,
      marketplace: p.marketplace,
      subject: parsed.subject,
      state: 'ignored',
      reason: 'Not a sale notice',
      sku: p.sku,
      item_title: p.item_title,
      order_number: p.order_number,
      sale_price_cents: p.price,
    });
    if (error) throw error;
    return { state: 'ignored' };
  }

  let reason = 'SKU or sale price was not found with confidence';
  // Exact photo / SKU / Vendoo-sold match only — never fuzzy title/price auto-finalize.
  const resolved = await resolveMarketplaceSku(sb, {
    storeId: store.id,
    marketplace: p.marketplace,
    sku: p.sku,
    photoIds: p.photo_ids,
  });
  if (resolved.sku) p.sku = resolved.sku;

  // Order-id dedupe before finalize: same marketplace order must never create a second sale.
  if (p.order_number) {
    const { data: prior } = await sb
      .from('marketplace_email_sales')
      .select('id,sale_id,state')
      .eq('store_id', store.id)
      .eq('order_number', p.order_number)
      .not('sale_id', 'is', null)
      .limit(1)
      .maybeSingle();
    if (prior?.sale_id) {
      await sb.from('marketplace_email_sales').upsert(
        {
          store_id: store.id,
          message_id: msg,
          marketplace: p.marketplace,
          subject: parsed.subject,
          state: 'matched',
          sku: p.sku,
          item_title: p.item_title,
          order_number: p.order_number,
          sale_price_cents: p.price,
          sale_id: prior.sale_id,
          reason: 'Duplicate of existing order',
          confidence: p.sku && p.price ? 0.99 : null,
        },
        { onConflict: 'store_id,message_id' },
      );
      return { state: 'duplicate', sku: p.sku, marketplace: p.marketplace, sale_id: prior.sale_id };
    }
  }

  // Stable order key (never raw Message-ID with <>/@) so payment_id dedupes with unmatched rows.
  const orderKey = orderKeyEarly;

  if (p.sku && p.price) {
    const { data: unit } = await sb
      .from('units')
      .select('sku,title,state')
      .eq('store_id', store.id)
      .eq('sku', p.sku)
      .maybeSingle();
    if (unit?.state === 'available') {
      const r = await sb.rpc('marketplace_ingest_sale', {
        p_store: store.id,
        p_sku: p.sku,
        p_channel: p.marketplace,
        p_price_cents: p.price,
        p_order_number: orderKey,
        p_message_id: msg,
        p_marketplace: p.marketplace,
        p_item_title: unit.title || p.item_title,
        p_ship_by: p.ship_by,
        p_fulfillment: p.fulfillment,
        p_buyer: p.buyer,
        p_confidence: 0.99,
        p_fee_cents: p.fee,
        p_ship_label_cents: p.ship_label,
        p_tax_cents: p.tax,
        p_payout_cents: p.payout,
      });
      if (!r.error) {
        // RPC returns null when it attached a duplicate order without a new sale.
        if (r.data == null) return { state: 'duplicate', sku: p.sku, marketplace: p.marketplace };
        return { state: 'matched', sku: p.sku, marketplace: p.marketplace, sale_id: r.data };
      }
      reason = r.error.message;
    } else reason = 'SKU did not match an available unit';
  }
  // Do not auto-finalize from title/price suggestions. A price-only hit wrongly
  // sold puzzle SKU 99096 as the measuring-cups Depop order. Unmatched sales
  // stay visible in Orders for a human Link SKU.

  const { error } = await sb.from('marketplace_email_sales').insert({
    store_id: store.id,
    message_id: msg,
    marketplace: p.marketplace,
    subject: parsed.subject,
    state: 'needs_review',
    sku: p.sku,
    item_title: p.item_title,
    order_number: p.order_number,
    sale_price_cents: p.price,
    ship_by: p.ship_by,
    fulfillment: p.fulfillment,
    buyer: p.buyer,
    fee_cents: p.fee,
    ship_label_cents: p.ship_label,
    tax_cents: p.tax,
    payout_cents: p.payout,
    confidence: p.sku && p.price ? 0.5 : null,
    reason,
  });
  if (error) throw error;

  // Non-negotiable: every detected sale appears in Orders, even without a SKU.
  const order = await ensureUnmatchedWebOrder(sb, {
    storeId: store.id,
    marketplace: p.marketplace,
    messageId: msg,
    orderNumber: orderKey.startsWith('msg:') ? null : orderKey,
    itemTitle: p.item_title,
    priceCents: p.price,
    shipBy: p.ship_by,
    fulfillment: p.fulfillment,
    buyer: p.buyer,
  });
  return { state: 'needs_review', marketplace: p.marketplace, web_order_id: order.id, order_created: order.created };
}
