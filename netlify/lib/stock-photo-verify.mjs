/** Vision check for a stock photo. A similar name from another year is not a match. */

const model = () => process.env.GEMINI_RECEIVE_MODEL || "gemini-3.5-flash-lite";

export function keepStockJudgment(row) {
  const shot = String(row?.shot || "");
  if (row?.same_product !== true) return false;
  if (row?.low_quality === true) return false;
  return shot === "product" || shot === "box_front";
}

const judgmentSchema = {
  type: "object",
  properties: {
    same_product: { type: "boolean" },
    shot: { type: "string", enum: ["product", "box_front", "box_back", "warning", "other"] },
    low_quality: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["same_product", "shot", "low_quality", "reason"],
};

async function gemini(parts, schema) {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model())}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: { responseMimeType: "application/json", responseJsonSchema: schema, maxOutputTokens: 300, thinkingConfig: { thinkingLevel: "LOW" } },
    }),
    signal: AbortSignal.timeout(45000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || `gemini_${response.status}`);
  const text = body.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "{}";
  return JSON.parse(text);
}

export async function imagePart(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: { Accept: "image/avif,image/webp,image/png,image/jpeg", "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(15000),
  });
  const mime = String(response.headers.get("content-type") || "").split(";")[0].toLowerCase();
  const bytes = Buffer.from(await response.arrayBuffer());
  const sniffed = /^image\/(jpeg|png|webp|gif)/.test(mime) ? mime : (/\.png(\?|$)/i.test(url) ? "image/png" : /\.webp(\?|$)/i.test(url) ? "image/webp" : /\.jpe?g(\?|$)/i.test(url) ? "image/jpeg" : "");
  if (!response.ok || !sniffed) return null;
  if (bytes.length < 1500 || bytes.length > 4_000_000) return null;
  return { inlineData: { mimeType: sniffed === "image/jpg" ? "image/jpeg" : sniffed, data: bytes.toString("base64") } };
}

export function productBrief(identity) {
  return [
    identity.expanded_title || identity.description,
    identity.brand && `Brand: ${identity.brand}`,
    identity.item_number && `Costco item number: ${identity.item_number}`,
    identity.upc && `UPC: ${identity.upc}`,
    identity.expanded_description,
  ].filter(Boolean).join("\n");
}

/** True only for a clean shot of this exact item. Box backs and other years are rejected. */
export async function judgeStockPhoto(url, identity) {
  const image = await imagePart(url);
  if (!image) return { skipped: true, same_product: false, shot: "other", low_quality: true, reason: "unreadable" };
  const row = await gemini([
    { text: `Confirmed product:\n${productBrief(identity)}\n\nCostco sells a new version of many items every year under almost the same name. Decide if this picture is THAT exact item, not a similar one.\nReject a different year, color, piece count, or set of figures.\nReject the back of a box, a warning label, a spec panel, a barcode close-up, and a tiny or blurry image.\nA clean product photo or the front of the box is acceptable.` },
    image,
  ], judgmentSchema);
  return row;
}

/** Compare the photo the clerk just took with the stock photo. */
export async function sameProductPhotos(stockUrl, userBase64, mime, identity) {
  const stock = await imagePart(stockUrl);
  if (!stock || !userBase64) return { same: true };
  const row = await gemini([
    { text: `Two photos. The first is a stock photo. The second was just taken of the item in hand.\nConfirmed product:\n${productBrief(identity)}\nAre these clearly the same product? A different year or a different set of pieces is not the same. Answer same=false when they are different products.` },
    stock,
    { inlineData: { mimeType: mime || "image/jpeg", data: userBase64 } },
  ], {
    type: "object",
    properties: { same: { type: "boolean" }, reason: { type: "string" }, visible_text: { type: "string" } },
    required: ["same", "reason", "visible_text"],
  });
  return row;
}
