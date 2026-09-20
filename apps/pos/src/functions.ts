import { floorCloud } from "@floor/cloud";

export function functionsUrl(path: string): string {
  const base = import.meta.env.VITE_FUNCTIONS_URL as string | undefined;
  if (!base) throw new Error("VITE_FUNCTIONS_URL is missing from this build");
  return `${base.replace(/\/$/, "")}/.netlify/functions/${path}`;
}

export async function authHeader(): Promise<Record<string, string>> {
  const { data } = await floorCloud().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("not_signed_in");
  return { Authorization: `Bearer ${token}` };
}

export async function callFunction(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = await authHeader();
  return fetch(functionsUrl(path), {
    ...init,
    headers: { ...headers, "Content-Type": "application/json", ...(init.headers || {}) },
  });
}
