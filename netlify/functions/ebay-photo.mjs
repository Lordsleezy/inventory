import { serviceClient } from "../lib/server.mjs";
import { verifyPhotoPath } from "../lib/ebay-photos.mjs";

export async function handler(event) {
  const path = event.queryStringParameters?.p || "";
  const sig = event.queryStringParameters?.sig || "";
  if (!verifyPhotoPath(path, sig)) {
    return { statusCode: 403, body: "forbidden" };
  }
  if (String(path).includes("/official-")) {
    return { statusCode: 404, body: "not found" };
  }
  const sb = serviceClient();
  const { data, error } = await sb.storage.from("unit-photos").download(path);
  if (error || !data) return { statusCode: 404, body: "not found" };
  const buf = Buffer.from(await data.arrayBuffer());
  const contentType = data.type || "image/jpeg";
  return {
    statusCode: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400",
    },
    body: buf.toString("base64"),
    isBase64Encoded: true,
  };
}
