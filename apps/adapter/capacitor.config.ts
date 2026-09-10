import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Standalone iOS product. Everything runs on the phone — no Surface, no
 * InvenTree, no server.url. Do not point Capacitor at a remote host.
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
    CapacitorSQLite: {
      iosDatabaseLocation: "Documents",
      iosIsEncryption: false,
    },
  },
};

export default config;
