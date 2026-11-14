import { requireEnv } from "./server.mjs";

const model = () => process.env.GEMINI_RECEIVE_MODEL || "gemini-3.5-flash-lite";

/** Ask Gemini to choose one item number from this lot. An unknown product comes back blank. */
export async function pickManifestItem({ brand, title, model: productModel, upc, lines }) {
  const rows = (lines || []).slice(0, 450).map((line) => {
    const item = String(line.item_number || line.tcin || "").replace(/[|\n]/g, "");
    if (!item) return "";
    const name = String(line.brand || "").replace(/[|\n]/g, "");
    const description = String(line.description || "").replace(/[|\n]/g, "");
    const prefix = String(line.upc_normalized || "").replace(/\D/g, "").slice(0, 6);
    return `${item}|${name}|${description}|${prefix}`;
  }).filter(Boolean);
  if (!rows.length) return "";
  const schema = {
    type: "object",
    properties: { item_number: { type: "string" } },
    required: ["item_number"],
  };
  const prompt = [
    "A photo of one product from a Costco pallet lot was identified.",
    `Photo: brand ${brand || "unknown"}, name ${title || "unknown"}, model ${productModel || "unknown"}.`,
    upc ? `The box barcode was ${upc}. It may be a club-pack code rather than the item UPC.` : "There was no barcode.",
    "The list columns are item_number|brand|description|upc prefix.",
    "Return the one item_number that is the same product. If none match, return an empty item_number.",
    "Do not guess. Do not invent an item number.",
    rows.join("\n"),
  ].join("\n");
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model())}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": requireEnv("GEMINI_API_KEY") },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: schema,
        maxOutputTokens: 200,
        thinkingConfig: { thinkingLevel: "LOW" },
      },
    }),
    signal: AbortSignal.timeout(45000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || `Gemini ${response.status}`);
  const text = body.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "{}";
  const parsed = JSON.parse(text);
  const item = String(parsed.item_number || "").trim();
  const allowed = new Set((lines || []).map((line) => String(line.item_number || line.tcin || "")));
  return allowed.has(item) ? item : "";
}
