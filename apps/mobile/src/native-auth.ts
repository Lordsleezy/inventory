import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import { setFloorCloudAuthStorage } from "@floor/cloud";

// Import this module before any screen that calls floorCloud().
if (Capacitor.isNativePlatform()) {
  // Memory cache in front of Preferences so getSession does not wait on a
  // bridge round-trip after the first read, and so auth recovery is stable.
  const cache = new Map<string, string>();
  setFloorCloudAuthStorage({
    getItem: async (key) => {
      if (cache.has(key)) return cache.get(key) ?? null;
      const { value } = await Preferences.get({ key });
      if (value != null) cache.set(key, value);
      return value;
    },
    setItem: async (key, value) => {
      cache.set(key, value);
      await Preferences.set({ key, value });
    },
    removeItem: async (key) => {
      cache.delete(key);
      await Preferences.remove({ key });
    },
  });
}
