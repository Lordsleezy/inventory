#!/usr/bin/env node

const base = "http://127.0.0.1:3000";

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

const created = await api("POST", "/api/sales", {}, c);
need(created.status === 200 && created.data.sale?.id, `create sale ${created.status} ${created.data.error ?? ""}`);
const id = created.data.sale.id;

const add = await api("POST", `/api/sales/${id}`, { op: "add", sku: "11118", price: "50.00" }, c);
need(add.status === 200 && add.data.sale.lines.some((l) => l.sku === "11118"), `add 11118 ${add.status} ${add.data.error ?? ""}`);

const dupe = await api("POST", `/api/sales/${id}`, { op: "add", sku: "11118", price: "50.00" }, c);
need(dupe.status === 409, `duplicate on same sale ${dupe.status} ${dupe.data.error ?? ""}`);

const add2 = await api("POST", `/api/sales/${id}`, { op: "add", sku: "11119", price: "40.00" }, c);
need(add2.status === 200 && add2.data.sale.lines.length === 2, `add 11119 ${add2.status} ${add2.data.error ?? ""}`);

const parked = await api("POST", `/api/sales/${id}`, { op: "park" }, c);
need(parked.status === 200 && parked.data.sale.status === "parked", `park ${parked.status} ${parked.data.error ?? ""}`);

const open = await api("GET", "/api/sales", undefined, c);
need(open.status === 200 && (open.data.sales ?? []).some((s) => s.id === id), "list parked");

const done = await api("POST", `/api/sales/${id}`, { op: "complete", paymentMethod: "cash" }, c);
need(done.status === 200 && done.data.sale.status === "completed", `complete ${done.status} ${done.data.error ?? ""}`);

const sold = await api("GET", "/api/units/11118", undefined, c);
need(sold.status === 200 && sold.data.unit.state === "sold", `11118 sold (${sold.data.unit?.state})`);

const second = await api("POST", "/api/sales", {}, c);
need(second.status === 200, "second sale");
const id2 = second.data.sale.id;
const locked = await api("POST", `/api/sales/${id2}`, { op: "add", sku: "11118", price: "50.00" }, c);
need(locked.status === 409, `double-sale lock ${locked.status} ${locked.data.error ?? ""}`);

const ret = await api(
  "POST",
  `/api/sales/${id}`,
  { op: "return", sku: "11118", restock: "available", reason: "live m5 return" },
  c,
);
need(ret.status === 200 && ret.data.unit.state === "available", `return ${ret.status} ${ret.data.error ?? ""}`);

const again = await api("POST", `/api/sales/${id2}`, { op: "add", sku: "11118", price: "50.00" }, c);
need(again.status === 200, `resell after return ${again.status} ${again.data.error ?? ""}`);

const cancel = await api("POST", `/api/sales/${id2}`, { op: "cancel" }, c);
need(cancel.status === 200 && (cancel.data.sale.status === "cancelled" || cancel.data.sale.lines.length === 0), `cancel ${cancel.status} ${cancel.data.error ?? ""}`);

const free = await api("GET", "/api/units/11118", undefined, c);
need(free.status === 200 && free.data.unit.state === "available", `11118 available after cancel (${free.data.unit?.state})`);

console.log("PASS M5 POS");
