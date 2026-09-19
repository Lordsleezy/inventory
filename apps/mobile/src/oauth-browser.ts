import { Browser } from "@capacitor/browser";
import { Capacitor } from "@capacitor/core";

/** iOS Capacitor Browser (Safari View) drops eBay’s `#` code. Stay in Floor’s WebView. */
export async function openConnectUrl(url: string): Promise<"assign" | "browser"> {
  if (Capacitor.getPlatform() === "ios") {
    window.location.assign(url);
    return "assign";
  }
  try {
    await Browser.close();
  } catch {
    /* no leftover in-app browser */
  }
  await Browser.open({ url });
  return "browser";
}

export async function openExternalUrl(url: string): Promise<void> {
  try {
    await Browser.open({ url });
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
