import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Standalone iOS product. Everything runs on the phone — no Surface, no
 * InvenTree, no server.url. Do not point Capacitor at a remote host.
 * server.allowNavigation only lets eBay/Netlify/Square OAuth stay in Floor’s WebView.
 */
const config: CapacitorConfig = {
  appId: "com.openboxindustries.floor",
  appName: "Floor",
  webDir: "www",
  ios: {
    scheme: "App",
    // Own safe-area padding in Shell; automatic inset fights the header.
    contentInset: "never",
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
      // Square OAuth (sandbox + production) must stay inside Floor’s WebView.
      "connect.squareup.com",
      "connect.squareupsandbox.com",
      "*.squareup.com",
      "*.squareupsandbox.com",
      "squareup.com",
      "squareupsandbox.com",
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
