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
  if (/^(?:time to ship|ship(?:ping)? reminder)\b/i.test(subj.trim()) || /\b(?:time to ship|ship(?:ping)? reminder)\b/i.test(subj)) {
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
  if (!SALE_SIGNAL.test(s)) return false;
  if (isMarketplaceNoise(subject, text)) {
    // A clear sale confirmation wins over a subject that looks like a ship reminder.
    return STRONG_SALE.test(s);
  }
  return true;
}

export function parseMail(mail, channels = defaultChannels) {
  const text = [mail.subject, mail.text || '', mail.html || ''].join('\n').replace(/<[^>]*>/g, ' ');
  const sender = mail.from?.address || '';
  const marketplace = marketplaceOf(`${sender} ${mail.subject} ${text.slice(0, 2000)}`, channels);
  const sale = looksLikeSaleNotice(mail.subject, text);
  const sku =
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
  const order =
    text.match(/(?:order|transaction)\s*(?:number|#|no\.?|id)?\s*[:#-]?\s*([A-Z0-9-]{5,40})/i)?.[1] ||
    text.match(/sale\s*(?:number|#|no\.?|id)\s*[:#-]?\s*([A-Z0-9-]{5,40})/i)?.[1] ||
    null;
  const ship = text.match(
    /(?:ship(?:ped)? by|ship before|ship no later than|ship by date)\s*[:\-]?\s*([A-Z][a-z]+\s+\d{1,2}(?:,\s*\d{4})?)/i,
  )?.[1];
  const name = text.match(/(?:ship to|shipping name|recipient)\s*[:\-]\s*([^\r\n]+)/i)?.[1] || null;
  const street =
    text.match(/\b\d{1,6}\s+[A-Za-z0-9.'# -]{3,70}\s(?:St|Street|Rd|Road|Ave|Avenue|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct)\.?\b/i)?.[0] ||
    null;
  const cityMatch = text.match(/([A-Za-z .'-]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)/);
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || null;
  const phone = text.match(/(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}/)?.[0] || null;
  const buyer = {
    ...(name ? { name } : {}),
    ...(street ? { line1: street } : {}),
    ...(cityMatch ? { city: cityMatch[1].trim(), region: cityMatch[2], postal: cityMatch[3], country: 'US' } : {}),
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
  };
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
    price,
    order_number: order,
    ship_by: ship ? safeDate(ship) : null,
    item_title: String(mail.subject || 'Marketplace order').slice(0, 250),
    buyer,
    fulfillment,
    fee,
    ship_label: shipLabel,
    tax,
    payout,
  };
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
                text: `Extract only these fields from this marketplace sale email: item_title, order_number, ship_by (YYYY-MM-DD or null), buyer_name, buyer_email, buyer_phone, ship_line1, ship_line2, ship_city, ship_region, ship_postal, ship_country. Return JSON only. Do not infer missing values. Email:\n${text.slice(0, 14000)}`,
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

/**
 * Parse one already-decoded email (PostalMime result) and run the same ingest path for every source:
 *   sale + exact SKU + price + available unit -> marketplace_ingest_sale
 *   anything else that looks like a sale     -> marketplace_email_sales (needs_review)
 *   non-sale mail                            -> marketplace_email_sales (ignored)
 * Returns { state: 'matched' | 'needs_review' | 'ignored' | 'duplicate', ... }. Throws on database errors
 * so pollers can leave the message unread and retry.
 *
 * Previously-ignored rows for the same Message-ID are deleted and re-evaluated so a parser fix
 * (or INCLUDE_SEEN rescan) can recover sales that were wrongly discarded.
 */
export async function ingestMarketplaceMail(sb, { store, channels, parsed, raw }) {
  const p = parseMail(parsed, channels);
  if (p.sale && (!p.buyer.line1 || !p.order_number || !p.ship_by) && process.env.GEMINI_API_KEY) {
    try {
      const hints = await geminiEmailHints(p.text);
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
  const { data: exists } = await sb
    .from('marketplace_email_sales')
    .select('id,state,sale_id')
    .eq('store_id', store.id)
    .eq('message_id', msg)
    .maybeSingle();
  if (exists) {
    if (exists.state === 'ignored' && !exists.sale_id) {
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
        p_order_number: p.order_number,
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
  return { state: 'needs_review', marketplace: p.marketplace };
}
