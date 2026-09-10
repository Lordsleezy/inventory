import type { Database as SqlJsDatabase } from "sql.js";
import type { Db, SqlValue } from "@floor/store";

async function loadInitSqlJs() {
  const mod = await import("sql.js/dist/sql-wasm.js");
  const init = (mod as { default?: unknown }).default ?? mod;
  if (typeof init !== "function") {
    throw new Error("sql.js did not load");
  }
  return init as (config?: { locateFile?: (file: string) => string }) => Promise<{
    Database: new (data?: Uint8Array) => SqlJsDatabase;
  }>;
}

/**
 * Browser-only driver. The phone never uses this — iOS talks to a real SQLite
 * file through @capacitor-community/sqlite. This exists so the same UI can be
 * exercised in a desktop browser, against the same SQL, without jeep-sqlite
 * (which deadlocks when more than one tab, or a leftover Vite HMR module,
 * already holds IndexedDB).
 */

const IDB_NAME = "floor-standalone";
const IDB_STORE = "kv";
const IDB_KEY = "db";

function idbGet(): Promise<Uint8Array | null> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction(IDB_STORE, "readonly");
      const get = tx.objectStore(IDB_STORE).get(IDB_KEY);
      get.onsuccess = () => {
        const value = get.result;
        resolve(value instanceof Uint8Array ? value : null);
      };
      get.onerror = () => reject(get.error);
    };
  });
}

function idbPut(bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(bytes, IDB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
  });
}

export async function openWebDb(): Promise<Db> {
  const initSqlJs = await loadInitSqlJs();
  const SQL = await initSqlJs({
    locateFile: () => `${import.meta.env.BASE_URL}assets/sql-wasm.wasm`,
  });

  const saved = await idbGet();
  const raw: SqlJsDatabase = saved ? new SQL.Database(saved) : new SQL.Database();
  let depth = 0;
  let persistQueued = false;

  async function persist() {
    if (depth > 0) {
      persistQueued = true;
      return;
    }
    persistQueued = false;
    await idbPut(raw.export());
  }

  return {
    async exec(sql) {
      raw.exec(sql);
      await persist();
    },

    async run(sql, params = []) {
      raw.run(sql, params as SqlValue[]);
      const last = raw.exec("SELECT last_insert_rowid() AS id, changes() AS n");
      const row = last[0]?.values[0];
      await persist();
      return {
        lastId: Number(row?.[0] ?? 0),
        changes: Number(row?.[1] ?? 0),
      };
    },

    async all(sql, params = []) {
      const stmt = raw.prepare(sql);
      try {
        if (params.length) stmt.bind(params as SqlValue[]);
        const rows: Record<string, SqlValue>[] = [];
        while (stmt.step()) {
          rows.push(stmt.getAsObject() as Record<string, SqlValue>);
        }
        return rows as never;
      } finally {
        stmt.free();
      }
    },

    async tx(fn) {
      if (depth > 0) return fn();
      raw.run("BEGIN IMMEDIATE");
      depth += 1;
      try {
        const out = await fn();
        raw.run("COMMIT");
        depth -= 1;
        await persist();
        return out;
      } catch (err) {
        try {
          raw.run("ROLLBACK");
        } catch {
          /* original error is the one worth reporting */
        }
        depth -= 1;
        if (persistQueued) await persist();
        throw err;
      }
    },

    async close() {
      await persist();
      raw.close();
    },
  };
}
