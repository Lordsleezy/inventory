import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Standalone iOS product. Everything runs on the phone — no Surface, no
 * InvenTree, no server.url. Do not point Capacitor at a remote host.
 * server.allowNavigation only lets eBay/Netlify OAuth stay in Floor’s WebView.
 */
const config: CapacitorConfig = {
  appId: "com.openboxindustries.floor",
  appName: "Floor",
  webDir: "www",
  ios: {
    scheme: "App",
    contentInset: "automatic",
    limitsNavigationsToAppBoundDomains: false,
  },
  server: {
    allowNavigation: [
      "inventoryobi.netlify.app",
      "*.netlify.app",
      "auth.ebay.com",
      "auth.sandbox.ebay.com",
      "signin.ebay.com",
      "signin.sandbox.ebay.com",
      "www.ebay.com",
      "www.sandbox.ebay.com",
      "*.ebay.com",
      "*.sandbox.ebay.com",
    ],
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
