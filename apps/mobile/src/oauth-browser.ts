import { Browser } from "@capacitor/browser";
import { Capacitor, registerPlugin } from "@capacitor/core";

type FloorAuthPlugin = {
  openAuth: (options: { url: string }) => Promise<{ ok: boolean }>;
};

const FloorAuth = registerPlugin<FloorAuthPlugin>("FloorSquare");

function unimplemented(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /not implemented|unimplemented/i.test(message);
}

export async function openConnectUrl(url: string): Promise<"native" | "browser"> {
  if (Capacitor.isNativePlatform()) {
    try {
      await FloorAuth.openAuth({ url });
      return "native";
    } catch (err) {
      if (String(err instanceof Error ? err.message : err) === "cancelled") throw err;
      if (!unimplemented(err)) throw err;
    }
  }
  try {
    await Browser.close();
  } catch {
    /* no leftover in-app browser */
  }
  await Browser.open({ url });
  return "browser";
}
