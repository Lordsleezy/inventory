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

type AuthStorage = {
  getItem: (key: string) => string | null | Promise<string | null>;
  setItem: (key: string, value: string) => void | Promise<void>;
  removeItem: (key: string) => void | Promise<void>;
};

let client: SupabaseClient | null = null;
let authStorageOverride: AuthStorage | undefined;

/** Native apps should pass Capacitor Preferences so the JWT survives WebView restarts. */
export function setFloorCloudAuthStorage(storage: AuthStorage | undefined): void {
  authStorageOverride = storage;
  client = null;
}

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

  const authStorage =
    authStorageOverride ||
    (typeof window === "undefined" ? memoryStorage : undefined);
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

async function loadAuthStateOnce(): Promise<AuthState> {
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
    const email = session.session.user.email ?? "";
    // Clock-number accounts never create a store. Do not signOut() here — that
    // re-enters onAuthStateChange and made the phone flap login/logout.
    if (/@(employees|staff)\.floor\.local$/i.test(email) || email.startsWith("android.probe@")) {
      return { kind: "signed_out" };
    }
    return {
      kind: "needs_store",
      userId: session.session.user.id,
      email,
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

export async function loadAuthState(): Promise<AuthState> {
  // A failed PostgREST transaction occasionally reaches the phone as 25P02
  // while the database is changing. Each request has its own transaction, so
  // retrying the read can recover without forcing the owner out of the app.
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await loadAuthStateOnce(); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (attempt === 2 || (code !== '25P02' && !/current transaction is aborted/i.test(message))) throw error;
      await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw new Error('Could not load Floor session');
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
  if (/PGRST203|Could not choose the best candidate function/i.test(text)) {
    return "Receive is out of date with the server (ambiguous function). Refresh the page and try again.";
  }
  if (/units_upc_valid_gtin|invalid_gtin/i.test(text)) {
    return "That barcode is not a valid UPC/EAN. Clear UPC or fix the digits, then save again.";
  }
  if (/condition_required/i.test(text)) return "Pick a condition, or clear the price to receive into Needs attention.";
  if (/brand_required|brand_invalid/i.test(text)) return "Enter a real brand (or mark Unbranded), or clear the price to receive into Needs attention.";
  if (/title_required/i.test(text)) return "Title is required to save a price. Clear the price to receive into Needs attention.";
  if (/category_required/i.test(text)) return "Category is required to save a price. Clear the price to receive into Needs attention.";
  if (/upc_required/i.test(text)) return "UPC is required to save a price. Clear the price to receive into Needs attention.";
  if (/package_required/i.test(text)) return "Package size/weight is required to save a price. Clear the price to receive into Needs attention.";
  if (/portal_access_denied/i.test(text)) return "Not signed in to a store — sign in again, then retry.";
  if (/unit_has_sales_history|void_the_sale_first/i.test(text)) {
    return "This item has sales history. Mark it sold or given away instead of deleting it.";
  }
  if (/unit_in_bundle/i.test(text)) return "This SKU is part of a bundle. Remove it from the bundle first.";
  if (/unit_listing_in_progress/i.test(text)) {
    return "A listing is still being published for this item. Wait a minute and try again.";
  }
  if (/unit_still_listed:(\w+)/i.test(text)) {
    const m = text.match(/unit_still_listed:(\w+)/i);
    const ch = (m?.[1] || "online").toLowerCase();
    const label =
      ch === "ebay" ? "eBay"
      : ch === "depop" ? "Depop"
      : ch === "whatnot" ? "Whatnot"
      : ch === "mercari" ? "Mercari"
      : ch === "amazon" ? "Amazon"
      : ch === "tiktok" ? "TikTok Shop"
      : ch === "facebook" ? "Facebook"
      : ch === "website" ? "the website"
      : ch.charAt(0).toUpperCase() + ch.slice(1);
    return `This item is still listed on ${label}. End the listing first.`;
  }
  if (/manager_approval_required/i.test(text)) return "Only store admins can delete inventory.";
  if (/violates foreign key constraint|foreign key/i.test(text)) {
    return "Couldn't delete this item because something is still linked to it. Refresh and try again.";
  }
  if (/sku_not_found/i.test(text)) return "That item is no longer in inventory.";
  if (/quantity_must_be_1_to_100/i.test(text)) return "Quantity must be 1–100.";
  if (/dims_must_be_positive/i.test(text)) return "Dimensions and weight must be positive numbers (or blank).";
  if (/invalid_shippable/i.test(text)) return "Shippable must be Automatic, Yes, or Pickup only.";
  if (/negative_amount/i.test(text)) return "Price and cost cannot be negative.";
  if (isNetworkFailureText(text) || isNetworkAuthFailure(err)) {
    const host = bakedSupabaseHost();
    const where = host ? ` (${host})` : "";
    return `Can't reach Floor cloud${where}. Check Wi‑Fi, confirm this register can reach Supabase, and rebuild the app if the cloud URL was wrong at build time.`;
  }
  const display = asPlainText(err);
  return display && display !== "[object Object]" ? display : text;
}
