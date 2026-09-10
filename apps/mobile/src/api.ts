const API_KEY = "floor.apiUrl";
const TOKEN_KEY = "floor.session";

export function getApiUrl(): string {
  return (localStorage.getItem(API_KEY) ?? "").replace(/\/$/, "");
}

export function setApiUrl(url: string) {
  const next = url.trim().replace(/\/$/, "");
  if (next) localStorage.setItem(API_KEY, next);
  else localStorage.removeItem(API_KEY);
}

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export function setToken(token: string) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export async function loadBundledConfig() {
  try {
    const res = await fetch("./config.json", { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as { apiUrl?: string };
    if (data.apiUrl && !localStorage.getItem(API_KEY)) setApiUrl(data.apiUrl);
  } catch {
    /* bundled default is optional */
  }
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const base = getApiUrl();
  if (!base) throw new Error("Set the Floor API address");
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(`${base}${path.startsWith("/") ? path : `/${path}`}`, { ...init, headers });
  if (res.status === 401) setToken("");
  return res;
}

export async function apiJson<T>(path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await apiFetch(path, init);
  const data = (await res.json().catch(() => ({}))) as T;
  return { ok: res.ok, status: res.status, data };
}

const blobCache = new Map<string, string>();

export async function apiBlobUrl(path: string): Promise<string> {
  const cached = blobCache.get(path);
  if (cached) return cached;
  const res = await apiFetch(path);
  if (!res.ok) throw new Error("Could not load file");
  const url = URL.createObjectURL(await res.blob());
  blobCache.set(path, url);
  return url;
}

export function forgetBlobUrl(path: string) {
  const url = blobCache.get(path);
  if (url) URL.revokeObjectURL(url);
  blobCache.delete(path);
}

export async function pingApi(origin: string): Promise<string> {
  const base = origin.trim().replace(/\/$/, "");
  const res = await fetch(`${base}/api/ping`, { cache: "no-store" });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; service?: string };
  if (!res.ok || !data.ok) throw new Error("That host is not Floor");
  return base;
}
