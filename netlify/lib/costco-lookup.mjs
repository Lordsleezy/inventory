/**
 * Costco club-pack enrichment for Floor UPC pre-warm / lookup.
 *
 * Costco.com often blocks datacenter IPs (429 / captcha). When the site is
 * reachable we scrape item # pages for title/brand/images/UPC. Otherwise we
 * fall back to eBay Browse keyword search (brand + description + item #) which
 * is free and works with the application token.
 *
 * Never invents sell price or cost. Read-only.
 */
import { ebayHosts } from "./ebay-env.mjs";

const FETCH_MS = 12000;
const clean = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

function emptyCostco(extra = {}) {
  return {
    found: false,
    title: null,
    brand: null,
    model: null,
    description: null,
    features: [],
    images: [],
    package: { length_in: null, width_in: null, height_in: null, weight_lb: null },
    manufacturer_upc: null,
    item_number: null,
    url: null,
    ...extra,
  };
}

async function fetchText(url, headers = {}) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept: "text/html,application/json",
      "Accept-Language": "en-US,en;q=0.9",
      ...headers,
    },
    signal: AbortSignal.timeout(FETCH_MS),
  });
  const text = await res.text();
  return { res, text };
}

function blockedHtml(text) {
  return /robot or human|access denied|captcha|cf-challenge|Attention Required/i.test(text || "");
}

/** Pull a manufacturer GTIN out of Costco HTML/JSON when present. */
function extractUpc(text) {
  const patterns = [
    /"upc"\s*:\s*"(\d{8,14})"/i,
    /"gtin(?:13|14)?"\s*:\s*"(\d{8,14})"/i,
    /"barcode"\s*:\s*"(\d{8,14})"/i,
    /itemProp="gtin1[34]"[^>]*content="(\d{8,14})"/i,
    /property="product:upc"[^>]*content="(\d{8,14})"/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1] && !/^4999/.test(m[1])) return m[1];
  }
  return null;
}

function extractMeta(text, prop) {
  const re = new RegExp(`(?:property|name)="${prop}"[^>]*content="([^"]+)"`, "i");
  const m = text.match(re) || text.match(new RegExp(`content="([^"]+)"[^>]*(?:property|name)="${prop}"`, "i"));
  return clean(m?.[1]?.replace(/&amp;/g, "&").replace(/&quot;/g, '"'));
}

function productImage(raw) {
  if (typeof raw !== "string") return "";
  const url = raw.replace(/&amp;/g, "&").replace(/\\u0026/g, "&").split("?")[0];
  if (!/^https:\/\//i.test(url)) return "";
  if (!/costco|scene7|gdx-assets|example\.com/i.test(url)) return "";
  if (/instacart|customer-service|privacy|favicon|logo|sprite|icon/i.test(url)) return "";
  return url;
}

function scoreProductImage(url) {
  return /\/\d{5,}_/.test(url) ? 1 : 0;
}

function parseCostcoHtml(text, itemNumber, url) {
  if (!text || blockedHtml(text)) return emptyCostco({ raw_error: "costco_blocked", item_number: itemNumber });
  const title =
    extractMeta(text, "og:title") ||
    clean((text.match(/<title>([^<]+)<\/title>/i) || [])[1]?.replace(/\s*\|\s*Costco.*$/i, ""));
  const description = extractMeta(text, "og:description") || extractMeta(text, "description");
  const image = extractMeta(text, "og:image");
  const images = [...new Set([
    image,
    ...[...text.matchAll(/https:\/\/[^"'\\\s>]+\.(?:jpe?g|png|webp|avif)(?:\?[^"'\\\s>]*)?/gi)].map((match) => match[0]),
  ].map(productImage).filter(Boolean))].sort((a, b) => scoreProductImage(b) - scoreProductImage(a)).slice(0, 8);
  const brand =
    clean((text.match(/"brand"\s*:\s*\{\s*"@type"\s*:\s*"Brand"\s*,\s*"name"\s*:\s*"([^"]+)"/i) || [])[1]) ||
    clean((text.match(/"brand"\s*:\s*"([^"]+)"/i) || [])[1]);
  const model = clean((text.match(/"model(?:Number)?"\s*:\s*"([^"]+)"/i) || [])[1]);
  const manufacturer_upc = extractUpc(text);
  if (!title && !manufacturer_upc && !image) {
    return emptyCostco({ raw_error: "costco_no_product", item_number: itemNumber, url });
  }
  return {
    found: Boolean(title || manufacturer_upc),
    title,
    brand,
    model,
    description,
    features: [],
    images,
    package: { length_in: null, width_in: null, height_in: null, weight_lb: null },
    manufacturer_upc,
    item_number: itemNumber || null,
    url,
    source: "costco",
  };
}

/** Fetch one Costco product page and pull its gallery. */
export async function costcoFromUrl(url, { fetchImpl } = {}) {
  const page = String(url || "");
  if (!/^https:\/\/([a-z0-9-]+\.)?costco\.(com|ca)\//i.test(page)) return emptyCostco({ raw_error: "costco_url_rejected", url: page });
  const doFetch = fetchImpl || fetchText;
  try {
    const { res, text } = await doFetch(page);
    if (res.status === 429) return emptyCostco({ raw_error: "costco_rate_limited", url: res.url || page });
    return parseCostcoHtml(text, "", res.url || page);
  } catch (e) {
    return emptyCostco({ raw_error: e?.name === "TimeoutError" ? "costco_timeout" : "costco_fetch_failed", url: page });
  }
}

/**
 * The item-number URL often is not the product page. Search for that exact
 * number and open the Costco page whose sku matches it.
 */
export async function costcoByItemSearch(itemNumber, { fetchImpl } = {}) {
  const id = String(itemNumber || "").replace(/\D/g, "");
  if (!id) return emptyCostco({ raw_error: "costco_item_required" });
  const doFetch = fetchImpl || ((url) => fetchText(url, { "User-Agent": "Mozilla/5.0" }));
  const load = async (url) => {
    let last = { res: { status: 0, url }, text: "" };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try { last = await doFetch(url); } catch { continue; }
      if (last.text) return last;
    }
    return last;
  };
  try {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`site:costco.com ${id}`)}`;
    const { text } = await load(searchUrl);
    if (!text.includes("uddg=")) return emptyCostco({ raw_error: "costco_search_failed", item_number: id });
    const links = [...new Set([...text.matchAll(/uddg=([^&"]+)/g)].map((match) => {
      try { return decodeURIComponent(match[1]); } catch { return ""; }
    }).filter((url) => /^https:\/\/www\.costco\.com\/p\//i.test(url)))].slice(0, 4);
    for (const page of links) {
      const loaded = await load(page);
      if (!loaded.text.includes(`"sku":"${id}"`)) continue;
      const parsed = parseCostcoHtml(loaded.text, id, loaded.res.url || page);
      if (parsed.images?.length) return parsed;
    }
  } catch {
    return emptyCostco({ raw_error: "costco_search_failed", item_number: id });
  }
  return emptyCostco({ raw_error: "costco_not_found", item_number: id });
}

/** Best-effort Costco.com fetch by warehouse item number. */
export async function costcoByItemNumber(itemNumber, { fetchImpl } = {}) {
  const id = String(itemNumber || "").replace(/\D/g, "");
  if (!id) return emptyCostco({ raw_error: "costco_item_required" });
  const doFetch = fetchImpl || fetchText;
  const urls = [
    `https://www.costco.com/p/-/${id}`,
    `https://www.costco.com/.product.${id}.html`,
  ];
  for (const url of urls) {
    try {
      const { res, text } = await doFetch(url);
      if (res.status === 429) return emptyCostco({ raw_error: "costco_rate_limited", item_number: id, url: res.url || url });
      if (res.status === 404) continue;
      const parsed = parseCostcoHtml(text, id, res.url || url);
      if (parsed.found || parsed.manufacturer_upc) return parsed;
      if (parsed.raw_error === "costco_blocked") return parsed;
    } catch (e) {
      return emptyCostco({
        raw_error: e?.name === "TimeoutError" ? "costco_timeout" : "costco_fetch_failed",
        item_number: id,
      });
    }
  }
  return emptyCostco({ raw_error: "costco_not_found", item_number: id });
}

async function ebayAppToken() {
  const id = process.env.EBAY_CLIENT_ID;
  const secret = process.env.EBAY_CLIENT_SECRET;
  if (!id || !secret) throw new Error("ebay_app_credentials_missing");
  const { api } = ebayHosts();
  const basic = Buffer.from(`${id}:${secret}`).toString("base64");
  const res = await fetch(`${api}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials&scope=" + encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
    signal: AbortSignal.timeout(FETCH_MS),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error_description || json.error || `ebay_token_${res.status}`);
  return { api, token: json.access_token };
}

/**
 * eBay Browse fallback when Costco.com is blocked or the UPC is a 4999 internal code.
 * Uses brand + description (+ optional item #) keywords; tries to discover a real manufacturer UPC.
 */
export async function ebayEnrichFromIdentity(identity = {}) {
  const brand = clean(identity.brand);
  const title = clean(identity.title) || clean(identity.description);
  const itemNumber = clean(identity.item_number);
  const q = [brand, title, itemNumber ? `Costco ${itemNumber}` : ""].filter(Boolean).join(" ").slice(0, 180);
  if (!q) return emptyCostco({ raw_error: "ebay_identity_required" });
  try {
    const { api, token } = await ebayAppToken();
    const params = new URLSearchParams({
      q,
      limit: "15",
      fieldgroups: "MATCHING_ITEMS,EXTENDED",
    });
    const res = await fetch(`${api}/buy/browse/v1/item_summary/search?${params}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": process.env.EBAY_MARKETPLACE_ID || "EBAY_US",
      },
      signal: AbortSignal.timeout(FETCH_MS),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return emptyCostco({ raw_error: `ebay_browse_${res.status}`, item_number: itemNumber });
    }
    const items = Array.isArray(body.itemSummaries) ? body.itemSummaries : [];
    if (!items.length) return emptyCostco({ raw_error: "ebay_no_matches", item_number: itemNumber });

    const top = items[0];
    // Browse hits are other sellers' photos. Never keep them.
    let manufacturer_upc = null;
    const gtinAspect = (top.localizedAspects || []).find((a) =>
      /upc|ean|gtin|isbn/i.test(String(a?.name || "")),
    );
    if (gtinAspect?.value) {
      const digits = String(gtinAspect.value).replace(/\D/g, "");
      if (/^\d{12,14}$/.test(digits) && !/^4999/.test(digits)) manufacturer_upc = digits;
    }
    const aspects = {};
    for (const a of top.localizedAspects || []) {
      const name = clean(a?.name);
      const value = clean(a?.value);
      if (name && value) aspects[name] = value;
    }
    return {
      found: true,
      title: clean(top.title),
      brand: brand || clean(aspects.Brand) || null,
      model: clean(aspects.Model) || clean(aspects["Model Number"]) || null,
      description: null,
      features: [],
      aspects,
      images: [],
      package: { length_in: null, width_in: null, height_in: null, weight_lb: null },
      manufacturer_upc,
      item_number: itemNumber || null,
      ebay_category_id: String(top.leafCategoryIds?.[0] || top.categories?.[0]?.categoryId || "") || null,
      url: clean(top.itemWebUrl),
      source: "ebay",
    };
  } catch (e) {
    return emptyCostco({
      raw_error: String(e?.message || e).slice(0, 200),
      item_number: itemNumber || null,
    });
  }
}

/**
 * Resolve a Costco pack: try Costco.com, then eBay Browse from manifest identity.
 */
export async function resolveCostcoPack({ itemNumber, brand, description, title, upc } = {}) {
  let costco = emptyCostco();
  if (itemNumber) costco = await costcoByItemNumber(itemNumber);
  if (costco.found) return { ...costco, via: "costco" };

  const ebay = await ebayEnrichFromIdentity({
    item_number: itemNumber,
    brand,
    description: description || title,
    title,
  });
  if (ebay.found) {
    return {
      ...ebay,
      via: "ebay",
      costco_error: costco.raw_error || null,
      // Keep Costco manufacturer UPC discovery if Costco returned one without a title.
      manufacturer_upc: ebay.manufacturer_upc || costco.manufacturer_upc || null,
    };
  }
  return {
    ...emptyCostco({
      item_number: itemNumber || null,
      raw_error: ebay.raw_error || costco.raw_error || "costco_unresolved",
    }),
    via: null,
    scanned_upc: upc || null,
  };
}
