import { floorCloud, authErrorMessage } from "./client.ts";

export class OfflineError extends Error {
  constructor() {
    super("Connect to the internet to sell or change inventory.");
    this.name = "OfflineError";
  }
}

export type DeviceNetwork = {
  connected: boolean;
  connectionType: string;
};

export type ReachCheck = {
  ok: boolean;
  detail: string;
};

export type Connectivity = {
  connected: boolean;
  connectionType: string;
  supabase: ReachCheck;
  functions: ReachCheck;
};

let getDeviceNetwork: () => Promise<DeviceNetwork> = async () => ({
  connected: true,
  connectionType: "unknown",
});

/** WKWebView's navigator.onLine is often false while Wi-Fi works. The app injects Capacitor Network. */
export function setDeviceNetworkGetter(fn: () => Promise<DeviceNetwork>): void {
  getDeviceNetwork = fn;
}

export async function readDeviceNetwork(): Promise<DeviceNetwork> {
  try {
    return await getDeviceNetwork();
  } catch {
    return { connected: true, connectionType: "unknown" };
  }
}

export async function probeSupabase(): Promise<ReachCheck> {
  try {
    const { error } = await floorCloud().auth.getUser();
    if (error) return { ok: false, detail: error.message };
    return { ok: true, detail: "ok" };
  } catch (err) {
    return { ok: false, detail: authErrorMessage(err) };
  }
}

export async function probeFunctions(functionsUrl?: string): Promise<ReachCheck> {
  const base = (functionsUrl || "").trim().replace(/\/$/, "");
  if (!base) return { ok: false, detail: "VITE_FUNCTIONS_URL not set" };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 2500);
  try {
    const res = await fetch(base, { method: "GET", redirect: "follow", signal: ac.signal });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    return { ok: true, detail: "ok" };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return { ok: false, detail: "timed out" };
    return { ok: false, detail: authErrorMessage(err) };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkConnectivity(functionsUrl?: string): Promise<Connectivity> {
  const net = await readDeviceNetwork();
  if (!net.connected) {
    return {
      connected: false,
      connectionType: net.connectionType,
      supabase: { ok: false, detail: "device offline" },
      functions: { ok: false, detail: "device offline" },
    };
  }
  const [supabase, functions] = await Promise.all([probeSupabase(), probeFunctions(functionsUrl)]);
  return {
    connected: true,
    connectionType: net.connectionType,
    supabase,
    functions,
  };
}

/** Only throws OfflineError when the device itself has no network. Other failures are the real error. */
export async function assertOnline(): Promise<void> {
  const net = await readDeviceNetwork();
  if (!net.connected) throw new OfflineError();
  const supabase = await probeSupabase();
  if (!supabase.ok) throw new Error(supabase.detail);
}
