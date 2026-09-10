import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Standalone iOS product: UI is bundled in `www` (Vite build from apps/mobile).
 * Do not point Capacitor at a remote host — that would load the Surface Next
 * site in a WebView. Live stock JSON uses FLOOR_API_URL inside the bundled app.
 */
const config: CapacitorConfig = {
  appId: "com.openboxindustries.floor",
  appName: "Floor",
  webDir: "www",
  ios: {
    scheme: "Floor",
    contentInset: "automatic",
    limitsNavigationsToAppBoundDomains: false,
  },
  plugins: {
    Camera: {
      presentationStyle: "popover",
    },
  },
};

export default config;
