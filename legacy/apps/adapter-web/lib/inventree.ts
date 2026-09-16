import { resolve } from "node:path";
import { InventreeClient, fetchToken } from "@floor/inventree";
import type { FloorSession } from "./session";

export function floorRoot() {
  const fromEnv = process.env.FLOOR_ROOT?.trim();
  if (fromEnv) return resolve(fromEnv);
  return resolve(process.cwd(), "..", "..");
}

export function inventreeUrl() {
  const url = process.env.INVENTREE_URL;
  if (!url) throw new Error("INVENTREE_URL is not set");
  return url.replace(/\/$/, "");
}

export function inventreeClient(session: FloorSession) {
  return new InventreeClient({ baseUrl: inventreeUrl(), token: session.token });
}

export async function tokenForInventreeUser(username: string, password: string) {
  return fetchToken(inventreeUrl(), username, password);
}
