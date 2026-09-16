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

export function authErrorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const message = String((err as { message: unknown }).message ?? "").trim();
    if (message) return message;
  }
  const text = String(err ?? "").trim();
  return text || "Something went wrong";
}
