#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const base = "http://127.0.0.1:3000";
const csv = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../seed_inventory.csv"), "utf8");

async function api(method, path, body, cookie) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const next = setCookie.find((c) => c.startsWith("floor_session=")) ?? cookie;
  return { status: res.status, data, cookie: next?.split(";")[0] };
}

const login = await api("POST", "/api/auth/login", { username: "admin", pin: process.env.FLOOR_DEV_PIN });
if (login.status !== 200) {
  console.error("FAIL login", login);
  process.exit(1);
}
const c = login.cookie;
const preview = await api("POST", "/api/import", { csv, commit: false }, c);
if (preview.status !== 200) {
  console.error("FAIL preview", preview);
  process.exit(1);
}
console.log("preview rows", preview.data.counts);
const commit = await api("POST", "/api/import", { csv, map: preview.data.map, commit: true }, c);
if (commit.status !== 200) {
  console.error("FAIL commit", commit);
  process.exit(1);
}
const dupes = (commit.data.results ?? []).filter((r) => String(r.error ?? "").includes("already exists"));
const created = (commit.data.results ?? []).filter((r) => r.status === "created");
const errors = (commit.data.results ?? []).filter((r) => r.status === "error");
console.log("created", created.length, "errors", errors.length, "dupes", dupes.length);
console.log("dupe skus", dupes.map((r) => r.sku).join(","));
if (dupes.length < 5) {
  console.error("FAIL expected duplicate SKUs 11111-11115");
  process.exit(1);
}
if (created.length < 20) {
  console.error("FAIL expected most of 11116-11142 to create");
  process.exit(1);
}
console.log("PASS M4 import");
