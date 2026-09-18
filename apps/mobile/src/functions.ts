export function functionsUrl(path: string): string {
  const base = import.meta.env.VITE_FUNCTIONS_URL as string | undefined;
  if (!base) throw new Error("VITE_FUNCTIONS_URL is missing from this build");
  return `${base.replace(/\/$/, "")}/.netlify/functions/${path}`;
}

export async function authHeader(): Promise<Record<string, string>> {
  const { floorCloud } = await import("@floor/cloud");
  const { data } = await floorCloud().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("not_signed_in");
  return { Authorization: `Bearer ${token}` };
}

export async function applyChannelListing(channel: string, skus: string[], listed: boolean): Promise<void> {
  const { floorCloud } = await import("@floor/cloud");
  const key = channel.trim().toLowerCase();
  if (key === "ebay") {
    const headers = await authHeader();
    const res = await fetch(functionsUrl(listed ? "ebay-list" : "ebay-withdraw"), {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(skus.length === 1 ? { sku: skus[0] } : { skus }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 409 && body.error === "ebay_not_connected") {
      /* fall through and mark locally */
    } else if (!res.ok) {
      const detail = String(body.message || "").trim();
      if (detail && !/^invalid$/i.test(detail) && detail !== "ebay_list_failed") {
        throw new Error(detail);
      }
      throw new Error("eBay rejected the listing. Open the unit and try again after the latest functions deploy.");
    } else {
      return;
    }
  }
  const { error } = await floorCloud().rpc(skus.length === 1 ? "set_listing" : "set_listings", {
    ...(skus.length === 1 ? { p_sku: skus[0] } : { p_skus: skus }),
    p_channel: channel,
    p_listed: listed,
  });
  if (error) throw error;
}
