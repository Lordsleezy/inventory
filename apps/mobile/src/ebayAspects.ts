import { authHeader, functionsUrl } from "./functions";

export type EbayAspectRow = {
  name: string;
  required?: boolean;
  recommended?: boolean;
  allowed?: string[];
  selectionOnly?: boolean;
  catalog?: boolean;
  value?: string;
  source?: string;
};

export type EbayAspectsPayload = {
  ok: boolean;
  category?: { slug: string; name: string; ebayCategoryId: string };
  categories?: { slug: string; name: string; ebayCategoryId: string }[];
  aspects?: EbayAspectRow[];
  missing?: string[];
  missingRecommended?: string[];
  ready?: boolean;
  refreshed?: boolean;
  message?: string;
  error?: string;
};

async function callEbayAspects(method: "GET" | "POST", pathQuery: string, body?: unknown): Promise<EbayAspectsPayload> {
  const headers = await authHeader();
  const res = await fetch(functionsUrl("ebay-aspects") + pathQuery, {
    method,
    headers: { ...headers, "Content-Type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as EbayAspectsPayload;
  if (!res.ok) throw new Error(json.message || json.error || "ebay_aspects_failed");
  return json;
}

export function fetchUnitEbayAspects(sku: string, refresh = false) {
  return callEbayAspects("GET", `?sku=${encodeURIComponent(sku)}${refresh ? "&refresh=1" : ""}`);
}

export function fetchCategoryEbayAspects(category: string) {
  return callEbayAspects("GET", `?category=${encodeURIComponent(category)}`);
}

export function saveEbayAspect(input: { sku?: string; skus?: string[]; aspect: string; value: string; remember?: boolean }) {
  return callEbayAspects("POST", "", input);
}
