import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import { setFloorCloudAuthStorage } from "@floor/cloud";

// Import this module before any screen that calls floorCloud().
if (Capacitor.isNativePlatform()) {
  setFloorCloudAuthStorage({
    getItem: async (key) => (await Preferences.get({ key })).value,
    setItem: async (key, value) => {
      await Preferences.set({ key, value });
    },
    removeItem: async (key) => {
      await Preferences.remove({ key });
    },
  });
}
