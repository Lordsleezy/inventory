#!/usr/bin/env node
import { TOKEN_PATH } from "../../packages/inventree/src/token.ts";
import { api, baseUrl } from "./http.mjs";
import { loadGlobalSettings, resolveRequiredSettings } from "./settings.mjs";

function pass(msg) {
  console.log(`PASS  ${msg}`);
}

function fail(msg) {
  console.error(`FAIL  ${msg}`);
}

async function main() {
  let failed = 0;

  const ping = await api("GET", "/api/");
  const version = ping["server-version"] ?? ping.version;
  if (!version) {
    fail(`API at ${baseUrl()} responded but had no server-version`);
    failed += 1;
  } else {
    pass(`API ${baseUrl()}  InvenTree ${version}`);
  }

  const settings = await loadGlobalSettings();
  if (!settings.length) {
    fail("GET /api/settings/global/ returned no settings");
    failed += 1;
  } else {
    pass(`read ${settings.length} global settings`);
  }

  const resolved = resolveRequiredSettings(settings);
  if (resolved.unique) pass(`unique-serials key is ${resolved.unique.key} = ${resolved.unique.value}`);
  else {
    fail("no globally-unique-serials setting on this instance");
    failed += 1;
  }
  if (resolved.deleteSerialized) pass(`delete-serialized key is ${resolved.deleteSerialized.key} = ${resolved.deleteSerialized.value}`);
  else {
    fail("no delete-serialized-stock setting on this instance");
    failed += 1;
  }
  if (resolved.editSerial) pass(`serial-edit key is ${resolved.editSerial.key} = ${resolved.editSerial.value}`);
  else console.log("WARN  no serial-edit setting found — confirm SKUs cannot be edited in Admin → Settings → Stock");

  const serialRelated = settings.filter((row) => /serial/i.test(`${row.key} ${row.name}`));
  console.log("serial-related keys:");
  for (const row of serialRelated) {
    console.log(`      ${row.key} = ${row.value}  (${row.name ?? ""})`);
  }

  try {
    const body = await api("GET", TOKEN_PATH);
    if (typeof body?.token === "string" && body.token.length > 0) {
      pass(`${TOKEN_PATH} returned a token`);
    } else {
      fail(`${TOKEN_PATH} responded but no token field`);
      failed += 1;
    }
  } catch (err) {
    if (err.status === 404) {
      fail(`${TOKEN_PATH} returned 404. That path is hard-configured from the M1 live probe. Do not guess /api/user/token/.`);
    } else {
      fail(`${TOKEN_PATH} → ${err.status ?? err.message}`);
    }
    failed += 1;
  }

  if (failed) {
    console.error(`FAIL  probe (${failed} check(s) failed)`);
    process.exit(1);
  }
  console.log("PASS  probe");
}

main().catch((err) => {
  console.error("FAIL  probe could not reach InvenTree");
  console.error(err.message ?? err);
  process.exit(1);
});
