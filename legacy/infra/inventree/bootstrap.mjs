#!/usr/bin/env node
/**
 * Milestone 1 proof against a live InvenTree:
 *  - discover settings from /api/settings/global/ (no guessed keys)
 *  - globally unique serials ON, serialized delete OFF, serial edit OFF if present
 *  - probe token endpoints
 *  - one Part, five StockItems (SKUs 11111–11115)
 *  - lros metadata written and read back
 *  - a sixth unit with SKU 11111 is rejected
 */
import { TOKEN_PATH } from "../../packages/inventree/src/token.ts";
import { api, emptyLros, idOf, rows } from "./http.mjs";
import { applyStockSettings, loadGlobalSettings } from "./settings.mjs";

async function requireConfiguredToken() {
  try {
    const body = await api("GET", TOKEN_PATH);
    if (typeof body?.token !== "string" || !body.token) {
      throw new Error(`${TOKEN_PATH} responded without a token field`);
    }
    return TOKEN_PATH;
  } catch (err) {
    if (err.status === 404) {
      throw new Error(
        `${TOKEN_PATH} returned 404. That path is hard-configured from the M1 live probe. Do not guess /api/user/token/.`,
      );
    }
    throw err;
  }
}

function pass(msg) {
  console.log(`PASS  ${msg}`);
}

async function main() {
  const ping = await api("GET", "/api/");
  const version = ping["server-version"] ?? ping.version ?? "unknown";
  pass(`InvenTree ${version}`);

  const settings = await loadGlobalSettings();
  const applied = await applyStockSettings(settings);
  pass(`settings ${applied.uniqueKey}=on ${applied.deleteSerializedKey}=off${applied.editSerialKey ? ` ${applied.editSerialKey}=off` : ""}`);
  if (applied.warning) console.warn("WARN ", applied.warning);

  const tokenPath = await requireConfiguredToken();
  pass(`token endpoint ${tokenPath}`);

  let part = rows(await api("GET", "/api/part/?IPN=LRFLC2716S"))[0];
  if (!part) {
    part = await api("POST", "/api/part/", {
      name: "LG LRFLC2716S",
      IPN: "LRFLC2716S",
      description: "French-door refrigerator",
      active: true,
      trackable: true,
      purchaseable: true,
      salable: true,
    });
  }
  const partId = idOf(part);
  pass(`part ${partId} ${part.name}`);

  const skus = ["11111", "11112", "11113", "11114", "11115"];
  for (const sku of skus) {
    const existing = rows(await api("GET", `/api/stock/?serial=${sku}`));
    let stockId;
    if (existing.length > 0) {
      stockId = idOf(existing[0]);
      pass(`SKU ${sku} already exists — pk ${stockId}`);
    } else {
      const created = await api("POST", "/api/stock/", {
        part: partId,
        quantity: 1,
        serial_numbers: sku,
        batch: "WAVE-0",
      });
      const item = Array.isArray(created) ? created[0] : created;
      stockId = idOf(item);
      pass(`created SKU ${sku} pk ${stockId}`);
    }
    await api("PATCH", `/api/stock/${stockId}/metadata/`, {
      metadata: {
        lros: {
          ...emptyLros,
          condition: sku === "11113" ? "Excellent" : null,
          askCents: sku === "11113" ? 145000 : null,
          mfrSerial: sku === "11111" ? "402KMXXXX" : null,
        },
      },
    });
    pass(`wrote metadata for SKU ${sku}`);
  }

  let collided = false;
  try {
    await api("POST", "/api/stock/", {
      part: partId,
      quantity: 1,
      serial_numbers: "11111",
    });
  } catch (err) {
    collided = err.status === 400;
    if (!collided) throw err;
  }
  if (!collided) throw new Error("SKU collision was NOT rejected — stop");
  pass("collision on 11111 rejected");

  const eleven = rows(await api("GET", "/api/stock/?serial=11113&part_detail=true"))[0];
  const meta = await api("GET", `/api/stock/${idOf(eleven)}/metadata/`);
  const elevenLros = meta.metadata?.lros ?? meta.lros;
  if (elevenLros?.askCents !== 145000) throw new Error("metadata round-trip failed");
  if (elevenLros?.condition !== "Excellent") throw new Error("condition lost");

  const empty = rows(await api("GET", "/api/stock/?serial=11112"))[0];
  const emptyMeta = await api("GET", `/api/stock/${idOf(empty)}/metadata/`);
  const emptyLrosRead = emptyMeta.metadata?.lros ?? emptyMeta.lros;
  if (emptyLrosRead?.askCents !== null) throw new Error("empty ask became a number");
  if (empty.purchase_price) throw new Error("empty acquisition cost should be blank, not a price");
  pass("11113 ask=145000 condition=Excellent; 11112 ask empty (not zero)");

  console.log("PASS  M1 proof");
  console.log(
    JSON.stringify(
      {
        version,
        tokenEndpoint: tokenPath,
        settings: applied,
        units: skus,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error("FAIL  M1 proof");
  console.error(err.message ?? err);
  process.exit(1);
});
