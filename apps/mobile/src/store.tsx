import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { initDb, loadSettings, saveSetting, type Db, type Settings } from "@floor/store";

type StoreValue = {
  db: Db;
  settings: Settings;
  setSetting: (key: keyof Settings, value: unknown) => Promise<void>;
  reloadSettings: () => Promise<void>;
};

const StoreContext = createContext<StoreValue | null>(null);

export function useStore(): StoreValue {
  const value = useContext(StoreContext);
  if (!value) throw new Error("useStore used outside StoreProvider");
  return value;
}

/** Convenience: the database on its own, which is what most screens want. */
export function useDb(): Db {
  return useStore().db;
}

/** Runs once per page load, however many times an effect is mounted. */
let booting: Promise<Db> | null = null;

function boot(): Promise<Db> {
  if (!booting) {
    booting = (async () => {
      // Browser: sql.js. Phone: a real SQLite file. Same schema either way.
      const db =
        Capacitor.getPlatform() === "web"
          ? await (await import("./driver-web")).openWebDb()
          : await (await import("@floor/store/capacitor")).openCapacitorDb();
      await initDb(db);
      return db;
    })().catch((err) => {
      booting = null;
      throw err;
    });
  }
  return booting;
}

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [db, setDb] = useState<Db | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const opened = await boot();
        const loaded = await loadSettings(opened);
        if (!live) return;
        setDb(opened);
        setSettings(loaded);
      } catch (err) {
        if (live) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const value = useMemo<StoreValue | null>(() => {
    if (!db || !settings) return null;
    return {
      db,
      settings,
      async setSetting(key, next) {
        await saveSetting(db, key as string, next);
        setSettings(await loadSettings(db));
      },
      async reloadSettings() {
        setSettings(await loadSettings(db));
      },
    };
  }, [db, settings]);

  if (error) {
    return (
      <div className="mx-auto max-w-md px-4 py-10 text-body">
        <p className="mb-2 text-floor-danger">Floor could not open its database.</p>
        <p className="text-quiet text-floor-mute">{error}</p>
        <p className="mt-4 text-quiet text-floor-mute">
          Your data has not been changed. Close the app and open it again. If this keeps happening,
          restore your most recent backup on a fresh install.
        </p>
      </div>
    );
  }

  if (!value) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-md items-center justify-center text-quiet text-floor-mute">
        Floor
      </div>
    );
  }

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}
