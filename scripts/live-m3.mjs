#!/usr/bin/env node
const base = "http://127.0.0.1:3000";

async function api(method, path, body, cookie) {
  const res = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const nextCookie = setCookie.find((c) => c.startsWith("floor_session=")) ?? cookie;
  return { status: res.status, data, cookie: nextCookie?.split(";")[0] };
}

const login = await api("POST", "/api/auth/login", { username: "admin", pin: process.env.FLOOR_DEV_PIN });
if (login.status !== 200) {
  console.error("FAIL login", login);
  process.exit(1);
}
const c = login.cookie;
console.log("PASS login");

const next = await api("GET", "/api/units?next=1", undefined, c);
console.log("next sku", next.data);

const received = [];
for (const row of [
  { brand: "Acme", model: "T100", title: "Test unit one", category: "Tools" },
  { brand: "Acme", model: "T100", title: "Test unit two", category: "Tools" },
  { brand: "Acme", model: "T200", title: "Test unit three", category: "Tools" },
]) {
  const res = await api("POST", "/api/units", { ...row, lot: "WAVE-M3" }, c);
  if (res.status !== 200) {
    console.error("FAIL receive", res);
    process.exit(1);
  }
  received.push(res.data.unit.sku);
  console.log("PASS receive", res.data.unit.sku, res.data.unit.brand, res.data.unit.model);
}

console.log("skus", received.join(","));
const [a, b, d] = received;

const inspect = await api("PATCH", `/api/units/${a}`, {
  op: "inspect",
  condition: "Excellent",
  testStatus: "passed",
  defectNotes: "",
  mfrSerial: "MFR-1",
  location: "Floor",
}, c);
if (inspect.status !== 200 || inspect.data.unit?.condition !== "Excellent") {
  console.error("FAIL inspect", inspect);
  process.exit(1);
}
console.log("PASS inspect", a, inspect.data.unit.condition);

const price = await api("PATCH", `/api/units/${b}`, {
  op: "price",
  msrp: "100.00",
  retail: "80.00",
  retailer: "Test Mart",
  capturedOn: "2026-09-03",
  ask: "50.00",
  floor: "30.00",
}, c);
if (price.status !== 200 || price.data.unit?.askCents !== 5000) {
  console.error("FAIL price", price);
  process.exit(1);
}
if (price.data.unit.floorCents !== 3000) {
  console.error("FAIL floor not saved for admin", price.data.unit);
  process.exit(1);
}
console.log("PASS price", b, "ask", price.data.unit.askCents);

const voided = await api("POST", `/api/units/${d}/void`, { reason: "M3 proof void" }, c);
if (voided.status !== 200 || voided.data.unit?.state !== "voided") {
  console.error("FAIL void", voided);
  process.exit(1);
}
console.log("PASS void", d, voided.data.unit.state);

const listed = await api("GET", "/api/units", undefined, c);
const skus = (listed.data.units ?? []).map((u) => u.sku);
if (skus.includes(d)) {
  console.error("FAIL voided unit still in default list", skus);
  process.exit(1);
}
console.log("PASS void excluded from list", skus.join(","));

const del = await api("POST", `/api/units/${b}/delete`, { typedSku: b }, c);
if (del.status !== 200) {
  console.error("FAIL hard delete", del);
  process.exit(1);
}
const gone = await api("GET", `/api/units/${b}`, undefined, c);
if (gone.status !== 404) {
  console.error("FAIL hard delete still present", gone);
  process.exit(1);
}
console.log("PASS hard delete", b);
console.log("PASS M3 live");
