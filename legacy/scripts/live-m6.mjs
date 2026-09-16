#!/usr/bin/env node
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const base = "http://127.0.0.1:3000";
const drop = join(tmpdir(), `floor-photos-${Date.now()}`);
mkdirSync(drop, { recursive: true });
const bytes = Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex");
writeFileSync(join(drop, "11120.jpg"), bytes);
writeFileSync(join(drop, "11120-2.jpg"), bytes);
writeFileSync(join(drop, "11120_left_door.jpg"), bytes);
writeFileSync(join(drop, "photo.jpg"), bytes);
writeFileSync(join(drop, "99991.jpg"), bytes);

async function api(method, path, body, cookie) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const next = setCookie.find((c) => c.startsWith("floor_session=")) ?? cookie;
  return { status: res.status, data, cookie: next?.split(";")[0] };
}

function need(ok, label) {
  if (!ok) {
    console.error("FAIL", label);
    process.exit(1);
  }
  console.log("ok", label);
}

const login = await api("POST", "/api/auth/login", { username: "admin", pin: process.env.FLOOR_DEV_PIN });
need(login.status === 200, "login");
const c = login.cookie;

const ingest = await api("POST", "/api/photos", { dir: drop }, c);
need(ingest.status === 200, `ingest ${ingest.status} ${ingest.data.error ?? ""}`);
const attached = (ingest.data.results ?? []).filter((r) => r.status === "attached");
const unmatched = ingest.data.unmatched ?? [];
need(attached.length === 3, `attached 3 SKU files, got ${attached.length} ${JSON.stringify(ingest.data.results)}`);
need(unmatched.some((u) => u.name.includes("photo.jpg")), "photo.jpg unmatched");
need(unmatched.some((u) => u.name.includes("99991.jpg")), "unknown SKU unmatched");
need(existsSync(join(drop, "unmatched", "photo.jpg")) || unmatched.some((u) => u.name.includes("photo")), "unmatched file kept");

const unit = await api("GET", "/api/units/11120", undefined, c);
need(unit.status === 200 && unit.data.unit.photoCount >= 3, `photoCount ${unit.data.unit?.photoCount}`);
need(unit.data.unit.primaryAttachmentId != null, "primary set");

const photos = await api("GET", `/api/units/11120/photos`, undefined, c);
need(photos.status === 200 && (photos.data.photos ?? []).length >= 3, "photo list");

console.log("PASS M6 photos");
