import type { CapacitorConfig } from "@capacitor/cli";

const url = (process.env.FLOOR_PUBLIC_URL || process.env.FLOOR_ORIGIN || "").replace(/\/$/, "");

const config: CapacitorConfig = {
  appId: "com.openboxindustries.floor",
  appName: "Floor",
  webDir: "public",
  server: url
    ? {
        url,
        cleartext: url.startsWith("http://"),
      }
    : {
        url: "http://127.0.0.1:3000",
        cleartext: true,
      },
  ios: {
    scheme: "Floor",
    contentInset: "automatic",
  },
  plugins: {
    Camera: {
      presentationStyle: "popover",
    },
  },
};

export default config;
