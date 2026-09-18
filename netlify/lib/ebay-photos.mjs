import { createHmac } from "node:crypto";
import { requireEnv } from "./server.mjs";

function photoSecret() {
  return requireEnv("CONNECTIONS_KEY");
}

export function signPhotoPath(path) {
  return createHmac("sha256", photoSecret()).update(String(path)).digest("hex").slice(0, 32);
}

export function publicPhotoUrl(path) {
  const origin = (() => {
    try {
      return new URL(process.env.OAUTH_REDIRECT_URI || "https://inventoryobi.netlify.app").origin;
    } catch {
      return "https://inventoryobi.netlify.app";
    }
  })();
  const q = new URLSearchParams({ p: path, sig: signPhotoPath(path) });
  return `${origin}/.netlify/functions/ebay-photo?${q}`;
}

export function verifyPhotoPath(path, sig) {
  if (!path || !sig) return false;
  const expected = signPhotoPath(path);
  return expected === String(sig);
}
