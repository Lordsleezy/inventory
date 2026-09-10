import { DatabaseSync } from "node:sqlite";
import type { Db, SqlValue } from "./db.ts";

/**
 * node:sqlite driver. Used by the test suite so the schema, triggers and
 * indexes exercised on a developer machine are byte-for-byte the ones the
 * phone runs.
 */
export function openNodeDb(filename = ":memory:"): Db {
  const raw = new DatabaseSync(filename);
  let depth = 0;

  return {
    async exec(sql) {
      raw.exec(sql);
    },
    async run(sql, params = []) {
      const stmt = raw.prepare(sql);
      const res = stmt.run(...(params as SqlValue[]));
      return { changes: Number(res.changes), lastId: Number(res.lastInsertRowid) };
    },
    async all(sql, params = []) {
      const stmt = raw.prepare(sql);
      return stmt.all(...(params as SqlValue[])) as never;
    },
    async tx(fn) {
      // Nested calls join the outer transaction rather than opening a second.
      if (depth > 0) return fn();
      raw.exec("BEGIN IMMEDIATE");
      depth += 1;
      try {
        const out = await fn();
        raw.exec("COMMIT");
        return out;
      } catch (err) {
        try {
          raw.exec("ROLLBACK");
        } catch {
          /* the original error is the one worth reporting */
        }
        throw err;
      } finally {
        depth -= 1;
      }
    },
    async close() {
      raw.close();
    },
  };
}
