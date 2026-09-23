import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const memory = new Map<string, string>();

const memoryStorage = {
  getItem: async (key: string) => memory.get(key) ?? null,
  setItem: async (key: string, value: string) => {
    memory.set(key, value);
  },
  removeItem: async (key: string) => {
    memory.delete(key);
  },
};

let client: SupabaseClient | null = null;

export function floorCloud(): SupabaseClient {
  if (client) return client;
  // Vite only inlines the exact identifiers import.meta.env.VITE_*. Do not
  // optional-chain or index — this file lives outside apps/mobile, so define
  // in vite.config.ts is what actually bakes the Codemagic values in.
  const url =
    import.meta.env.VITE_SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL ||
    process.env.SUPABASE_URL;
  const anon =
    import.meta.env.VITE_SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) {
    throw new Error("Supabase URL / anon key missing from this build");
  }

  const authStorage = typeof window === "undefined" ? memoryStorage : undefined;
  client = createClient(url, anon, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      storage: authStorage,
    },
  });
  return client;
}

export function resetFloorCloud(): void {
  client = null;
}

export type StaffSession = {
  userId: string;
  storeId: string;
  role: "owner" | "manager" | "staff";
  displayName: string;
  notifyEmail: boolean;
  notifyPush: boolean;
};

export type AuthState =
  | { kind: "signed_out" }
  | { kind: "needs_store"; userId: string; email: string }
  | { kind: "ready"; session: StaffSession };

export async function loadAuthState(): Promise<AuthState> {
  const sb = floorCloud();
  const { data: session, error: sessionError } = await sb.auth.getSession();
  if (sessionError) throw sessionError;
  if (!session.session) return { kind: "signed_out" };
  const { data, error } = await sb
    .from("staff")
    .select("store_id, role, display_name, notify_email, notify_push")
    .eq("user_id", session.session.user.id)
    .is("deactivated_at", null)
    .maybeSingle();
  if (error) throw error;
  if (!data?.store_id) {
    return {
      kind: "needs_store",
      userId: session.session.user.id,
      email: session.session.user.email ?? "",
    };
  }
  return {
    kind: "ready",
    session: {
      userId: session.session.user.id,
      storeId: data.store_id,
      role: data.role as StaffSession["role"],
      displayName: data.display_name,
      notifyEmail: data.notify_email,
      notifyPush: data.notify_push,
    },
  };
}

export async function loadStaffSession(): Promise<StaffSession | null> {
  const state = await loadAuthState();
  return state.kind === "ready" ? state.session : null;
}

function asPlainText(value: unknown, depth = 0): string {
  if (value == null) return "";
  if (typeof value === "string") {
    const t = value.trim();
    return t === "[object Object]" ? "" : t;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (depth > 5) return "";
  if (value instanceof Error) return asPlainText(value.message, depth + 1);
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    for (const key of ["message", "details", "hint", "error_description", "error"]) {
      const t = asPlainText(o[key], depth + 1);
      if (t) return t;
    }
    try {
      const json = JSON.stringify(value);
      if (json && json !== "{}" && json !== "[]" && json !== "null") return json;
    } catch {
      /* ignore */
    }
  }
  return "";
}

function skuFromText(text: string): string | null {
  const keyed = text.match(/\(sku\)=\((\d+)\)/i);
  if (keyed) return keyed[1];
  const labeled = text.match(/\bSKU\s+(\d+)\b/i);
  if (labeled) return labeled[1];
  return null;
}

function bakedSupabaseHost(): string {
  // Exact import.meta.env.VITE_* so Vite inlines the build-time URL.
  let url = "";
  try {
    url = String(import.meta.env.VITE_SUPABASE_URL || "");
  } catch {
    /* node tests / non-vite */
  }
  if (!url) {
    url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "";
  }
  try {
    return url ? new URL(url).host : "";
  } catch {
    return "";
  }
}

function isNetworkFailureText(text: string): boolean {
  return /load failed|failed to fetch|networkerror|network request failed|fetch failed|net::err_/i.test(
    text,
  );
}

/** True when the underlying error looks like a WebKit/browser network failure. */
export function isNetworkAuthFailure(err: unknown): boolean {
  let search = asPlainText(err);
  if (err && typeof err === "object") {
    const o = err as Record<string, unknown>;
    const joined = ["message", "details", "hint", "name"]
      .map((key) => asPlainText(o[key]))
      .filter(Boolean)
      .join(" ");
    if (joined) search = `${search} ${joined}`.trim();
  }
  return isNetworkFailureText(search);
}

/** Never returns "[object Object]". Unwraps PostgREST / Postgres errors. */
export function authErrorMessage(err: unknown): string {
  let search = asPlainText(err);
  if (err && typeof err === "object") {
    const o = err as Record<string, unknown>;
    const joined = ["message", "details", "hint"]
      .map((key) => asPlainText(o[key]))
      .filter(Boolean)
      .join(" ");
    if (joined) search = joined;
  }
  const text = search && search !== "[object Object]" ? search : "Something went wrong";
  if (/duplicate key|unique constraint|sku_ledger_pkey|units_sku/i.test(text)) {
    const sku = skuFromText(text);
    if (sku) return `SKU ${sku} was used before and can't be reused.`;
    return "That SKU was used before and can't be reused.";
  }
  if (/invalid_sku/i.test(text)) return "SKU must be digits.";
  if (/no_store/i.test(text)) return "This account is not attached to a store yet.";
  if (isNetworkFailureText(text) || isNetworkAuthFailure(err)) {
    const host = bakedSupabaseHost();
    const where = host ? ` (${host})` : "";
    return `Can't reach Floor cloud${where}. Check Wi‑Fi, confirm this register can reach Supabase, and rebuild the app if the cloud URL was wrong at build time.`;
  }
  const display = asPlainText(err);
  return display && display !== "[object Object]" ? display : text;
}
