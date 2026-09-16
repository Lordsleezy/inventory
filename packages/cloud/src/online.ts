import { floorCloud } from "./client.ts";

export class OfflineError extends Error {
  constructor() {
    super("Connect to the internet to sell or change inventory.");
    this.name = "OfflineError";
  }
}

export async function assertOnline(): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    throw new OfflineError();
  }
  const sb = floorCloud();
  const { error } = await sb.from("staff").select("user_id").limit(1);
  if (error) throw new OfflineError();
}
