import { Capacitor } from "@capacitor/core";
import {
  CapacitorSQLite,
  SQLiteConnection,
  type SQLiteDBConnection,
} from "@capacitor-community/sqlite";

import type { Db, SqlValue } from "./db.ts";

/**
 * The phone's database.
 *
 * The file lives in the app's Documents directory, which iOS includes in
 * iCloud and iTunes/Finder backups and never evicts to reclaim space. That
 * matters: WKWebView's IndexedDB and localStorage can both be purged under
 * storage pressure, so neither is a safe home for the only copy of the
 * inventory.
 */

const DB_NAME = "floor";

let connection: SQLiteDBConnection | null = null;
let sqlite: SQLiteConnection | null = null;
const isWeb = Capacitor.getPlatform() === "web";

/** On web the database lives in IndexedDB and must be flushed after writes. */
async function persist(): Promise<void> {
  if (!isWeb || !sqlite) return;
  try {
    await sqlite.saveToStore(DB_NAME);
  } catch {
    /* a failed flush is not worth losing the write over */
  }
}

/**
 * Opening is a singleton promise rather than a plain guard.
 *
 * React StrictMode mounts effects twice, and two overlapping opens used to
 * race: the second call saw a half-built connection object and asked for a
 * database before the web store had been initialized. Handing every caller
 * the same promise means the work happens exactly once no matter who asks.
 */
let opening: Promise<Db> | null = null;

export function openCapacitorDb(): Promise<Db> {
  if (!opening) {
    opening = open().catch((err) => {
      opening = null; // let a later attempt retry rather than fail forever
      throw err;
    });
  }
  return opening;
}

/**
 * Never wait forever. The browser store opens IndexedDB, and IndexedDB simply
 * blocks with no error when another tab already holds the database open —
 * which shows up as an app that sits on its splash screen. A timeout turns
 * that into something a person can act on.
 */
async function withDeadline<T>(work: Promise<T>, ms: number, whenStuck: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(whenStuck)), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer!);
  }
}

async function open(): Promise<Db> {
  if (isWeb) {
    // jeep-sqlite reads and writes through a custom element, which has to be
    // in the document and upgraded before the web store can be initialized.
    if (!document.querySelector("jeep-sqlite")) {
      document.body.appendChild(document.createElement("jeep-sqlite"));
    }
    await withDeadline(
      customElements.whenDefined("jeep-sqlite"),
      10000,
      "The browser database component never loaded.",
    );
  }

  sqlite = new SQLiteConnection(CapacitorSQLite);
  if (isWeb) {
    await withDeadline(
      sqlite.initWebStore(),
      10000,
      "The browser database did not open. Close any other tab that has Floor open and reload — only one tab can use it at a time.",
    );
  }

  await sqlite.checkConnectionsConsistency().catch(() => undefined);
  const existing = await sqlite.isConnection(DB_NAME, false);
  connection = existing.result
    ? await sqlite.retrieveConnection(DB_NAME, false)
    : await sqlite.createConnection(DB_NAME, false, "no-encryption", 1, false);

  const conn = connection;
  const open = await conn.isDBOpen();
  if (!open.result) await conn.open();

  let depth = 0;

  return {
    async exec(sql) {
      // transaction: false — transactions are managed by tx() below, not by
      // the plugin, so a nested BEGIN never fights our own.
      await conn.execute(sql, false);
      await persist();
    },

    async run(sql, params = []) {
      const res = await conn.run(sql, params as SqlValue[], false, "no");
      await persist();
      return {
        changes: Number(res.changes?.changes ?? 0),
        lastId: Number(res.changes?.lastId ?? 0),
      };
    },

    async all(sql, params = []) {
      const res = await conn.query(sql, params as SqlValue[]);
      return (res.values ?? []) as never;
    },

    async tx(fn) {
      if (depth > 0) return fn();
      await conn.execute("BEGIN IMMEDIATE", false);
      depth += 1;
      try {
        const out = await fn();
        await conn.execute("COMMIT", false);
        await persist();
        return out;
      } catch (err) {
        try {
          await conn.execute("ROLLBACK", false);
        } catch {
          /* the original error is the one worth reporting */
        }
        throw err;
      } finally {
        depth -= 1;
      }
    },

    async close() {
      await persist();
      await conn.close();
      connection = null;
      opening = null;
    },
  };
}

/** Absolute-ish location of the database file, for the backup screen. */
export async function databaseLocation(): Promise<string> {
  if (isWeb) return "browser storage (development only)";
  return `Documents/${DB_NAME}SQLite.db`;
}
