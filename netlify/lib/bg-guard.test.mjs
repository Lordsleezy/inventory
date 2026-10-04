import test from "node:test";
import assert from "node:assert/strict";
import { dbBusy, withLock } from "./bg-guard.mjs";

// A fake supabase client whose lock RPC behaves like try_job_lock (one holder until released/expired).
function fakeDb({ active = 0, probeError = null, delayMs = 0 } = {}) {
  const locks = new Map();
  return {
    rpc: async (name, args) => {
      if (name === "try_job_lock") {
        const held = locks.get(args.p_name);
        if (held && held.until > Date.now()) return { data: false, error: null };
        locks.set(args.p_name, { owner: args.p_owner, until: Date.now() + args.p_ttl_seconds * 1000 });
        return { data: true, error: null };
      }
      if (name === "release_job_lock") { const l = locks.get(args.p_name); if (l?.owner === args.p_owner) l.until = 0; return { error: null }; }
      if (name === "bg_db_probe") { if (delayMs) await new Promise((r) => setTimeout(r, delayMs)); return probeError ? { data: null, error: probeError } : { data: { active }, error: null }; }
      throw new Error(`unexpected rpc ${name}`);
    },
  };
}

test("overlapping runs never happen: the second caller is skipped while the first is running", async () => {
  const sb = fakeDb();
  let running = 0, maxRunning = 0, ran = 0;
  const job = async () => { running++; maxRunning = Math.max(maxRunning, running); ran++; await new Promise((r) => setTimeout(r, 30)); running--; return "done"; };
  const [a, b, c] = await Promise.all([withLock("x", 60, job, sb), withLock("x", 60, job, sb), withLock("x", 60, job, sb)]);
  assert.equal(maxRunning, 1);
  assert.equal(ran, 1);
  assert.equal([a, b, c].filter((r) => r?.skipped).length, 2);
  assert.equal(await withLock("x", 60, job, sb), "done"); // released afterwards
});

test("the lock is released even when the job throws", async () => {
  const sb = fakeDb();
  await assert.rejects(withLock("y", 60, async () => { throw new Error("boom"); }, sb), /boom/);
  assert.equal(await withLock("y", 60, async () => "again", sb), "again");
});

test("different jobs do not block each other", async () => {
  const sb = fakeDb();
  const [a, b] = await Promise.all([withLock("one", 60, async () => { await new Promise((r) => setTimeout(r, 20)); return 1; }, sb), withLock("two", 60, async () => 2, sb)]);
  assert.deepEqual([a, b], [1, 2]);
});

test("dbBusy: quiet database is not busy; many active queries, a slow probe, or a probe error are", async () => {
  assert.equal(await dbBusy(fakeDb({ active: 1 })), false);
  assert.equal(await dbBusy(fakeDb({ active: 9 })), true);
  assert.equal(await dbBusy(fakeDb({ probeError: { message: "timeout" } })), true);
  assert.equal(await dbBusy(fakeDb({ delayMs: 60 }), { maxMs: 20 }), true);
});
