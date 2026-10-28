import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyTikTokWebhookSignature(rawBody, signature, appKey = process.env.TIKTOK_SHOP_APP_KEY, appSecret = process.env.TIKTOK_SHOP_APP_SECRET) {
  if (!appKey || !appSecret || !signature) return false;
  const expected = createHmac("sha256", appSecret).update(`${appKey}${rawBody}`).digest("hex");
  const supplied = String(signature).replace(/^(?:HMAC|sha256)=/i, "").trim();
  try {
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(supplied, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch { return false; }
}
