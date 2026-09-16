export const CHANNEL_HOMES: Record<string, string> = {
  ebay: "https://www.ebay.com/",
  facebook: "https://www.facebook.com/marketplace",
  tiktok: "https://www.tiktok.com/",
  amazon: "https://www.amazon.com/",
};

export const CHANNEL_ALLOW_HOSTS: Record<string, string[]> = {
  ebay: ["ebay.com", "ebaystatic.com", "ebayimg.com", "ebayrtm.com", "ebayadservices.com"],
  facebook: ["facebook.com", "fbcdn.net", "facebook.net", "messenger.com"],
  tiktok: ["tiktok.com", "tiktokcdn.com", "tiktokv.com", "bytedance.com"],
  amazon: ["amazon.com", "amazon-adsystem.com", "ssl-images-amazon.com", "media-amazon.com"],
};

function hostMatches(hostname: string, allowed: string[]) {
  const host = hostname.toLowerCase();
  return allowed.some((base) => host === base || host.endsWith(`.${base}`));
}

export function marketplaceNavAllowed(
  url: string,
  input: { unrestricted: boolean; channel: string },
): boolean {
  if (input.unrestricted) return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  const allowed = CHANNEL_ALLOW_HOSTS[input.channel] ?? [];
  return hostMatches(parsed.hostname, allowed);
}
