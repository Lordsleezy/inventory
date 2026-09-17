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
  try {
    const res = await fetch(base, { method: "GET", redirect: "follow" });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    return { ok: true, detail: "ok" };
  } catch (err) {
    return { ok: false, detail: authErrorMessage(err) };
  }
}

export async function checkConnectivity(functionsUrl?: string): Promise<Connectivity> {
  const net = await readDeviceNetwork();
  const supabase = net.connected
    ? await probeSupabase()
    : { ok: false, detail: "device offline" };
  const functions = net.connected
    ? await probeFunctions(functionsUrl)
    : { ok: false, detail: "device offline" };
  return {
    connected: net.connected,
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
