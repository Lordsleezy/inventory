import sharp from "sharp";
import { modelSeeds } from "./model-seeds.mjs";

const allowedHosts = ["bosch-home.com", "samsung.com", "lg.com", "hisense-usa.com", "frigidaire.com", "midea.com", "ashleyfurniture.com", "store.ashley.sa", "costco.com", "homedepot.com", "lowes.com", "bestbuy.com", "abt.com", "cuisinart.com", "ninja.com", "kohler.com", "kutanoequipment.com"];
const timeout = (ms = 12000) => AbortSignal.timeout(ms);
const compact = (value) => String(value || "").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
const modelIn = (value, model) => new RegExp(`(^|[^a-z0-9])${model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").toLowerCase()}([^a-z0-9]|$)`, "i").test(value);
const allowed = (url) => { try { const host = new URL(url).hostname.toLowerCase(); return allowedHosts.some((x) => host === x || host.endsWith(`.${x}`)); } catch { return false; } };

function searchLinks(html) {
  const found = [];
  for (const match of html.matchAll(/<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    let url = match[1].replace(/&amp;/g, "&");
    if (url.startsWith("https://www.bing.com/ck/")) {
      const encoded = new URL(url).searchParams.get("u") || "";
      if (encoded.startsWith("a1")) url = Buffer.from(encoded.slice(2), "base64").toString("utf8");
    }
    found.push({ url, title: compact(match[2]) });
  }
  return found;
}

function meta(html, key) {
  const tag = [...html.matchAll(/<meta\s+[^>]*>/gi)].map((m) => m[0]).find((t) => t.includes(`name="${key}"`) || t.includes(`property="${key}"`));
  return tag?.match(/content="([^"]*)"/i)?.[1]?.replace(/&amp;/g, "&") || "";
}

export async function findExactModel(row) {
  const key = `${row.brand_key}|${row.model_key}`;
  if (modelSeeds[key]) return modelSeeds[key];
  // These recorded IDs cannot distinguish the actual variant from public listings.
  if (key === "kutano|kut50frn" || key === "hisense|efu14n6awe") return null;
  if (!/^[a-z0-9/.-]{5,}$/i.test(row.model) || !/\d/.test(row.model)) return null;
  const search = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(`"${row.model}" "${row.brand}"`)}`, { headers: { "user-agent": "Mozilla/5.0" }, signal: timeout() });
  if (!search.ok) throw new Error(`search_http_${search.status}`);
  const links = searchLinks(await search.text()).filter(({ url, title }) => allowed(url) && modelIn(`${url} ${title}`, row.model)).slice(0, 5);
  for (const link of links) {
    try {
      const response = await fetch(link.url, { headers: { "user-agent": "Mozilla/5.0" }, signal: timeout() });
      if (!response.ok || !String(response.headers.get("content-type")).includes("text/html")) continue;
      const html = await response.text();
      const title = meta(html, "og:title") || compact(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
      if (!modelIn(`${link.title} ${title}`, row.model)) continue;
      const description = compact(meta(html, "description") || meta(html, "og:description"));
      const imageUrls = [...html.matchAll(/https?:[^"'<>\s]+?\.(?:webp|jpe?g|png)(?:\?[^"'<>\s]*)?/gi)]
        .map((m) => m[0].replace(/&amp;/g, "&"))
        .filter((url) => modelIn(url, row.model) && !/logo|icon|banner|badge/i.test(url));
      const images = [...new Set(imageUrls)].slice(0, 3);
      if (description || images.length) return { source: link.url, title, description: description || title, specs: {}, images };
    } catch { /* Try the next exact-model result. */ }
  }
  return null;
}

export async function photoBuffers(url) {
  const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" }, signal: timeout(20000) });
  if (!response.ok) throw new Error(`photo_http_${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 12_000_000) throw new Error("photo_too_large");
  const metadata = await sharp(bytes).metadata();
  if (!metadata.width || !metadata.height || metadata.width < 300 || metadata.height < 300) throw new Error("photo_too_small");
  return {
    original: await sharp(bytes).rotate().resize(1800, 1800, { fit: "inside", withoutEnlargement: true }).webp({ quality: 85 }).toBuffer(),
    small: await sharp(bytes).rotate().resize(400, 400, { fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer(),
    large: await sharp(bytes).rotate().resize(1200, 1200, { fit: "inside", withoutEnlargement: true }).webp({ quality: 84 }).toBuffer(),
  };
}
