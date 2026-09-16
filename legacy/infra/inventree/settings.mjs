import { api, listAll } from "./http.mjs";

function haystack(setting) {
  return [setting.key, setting.name, setting.description]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function findOne(settings, { key, match, label }) {
  if (key) {
    const byKey = settings.find((row) => row.key === key);
    if (byKey) return byKey;
  }
  const matches = settings.filter((row) => match(haystack(row)));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `${label}: multiple settings matched (${matches.map((row) => row.key).join(", ")}). Refusing to guess.`,
    );
  }
  return null;
}

export async function loadGlobalSettings() {
  return listAll("/api/settings/global/");
}

export function resolveRequiredSettings(settings) {
  const unique = findOne(settings, {
    key: "SERIAL_NUMBER_GLOBALLY_UNIQUE",
    label: "globally unique serials",
    match: (text) => text.includes("globally unique") && text.includes("serial"),
  });
  const deleteSerialized = findOne(settings, {
    key: "STOCK_ALLOW_DELETE_SERIALIZED",
    label: "delete serialized stock",
    match: (text) => text.includes("delete") && text.includes("serialized"),
  });
  const editSerial = findOne(settings, {
    key: settings.find((row) => /serial/i.test(row.key ?? "") && /edit/i.test(row.key ?? ""))?.key,
    label: "edit serial number",
    match: (text) => text.includes("edit") && text.includes("serial"),
  });

  return { unique, deleteSerialized, editSerial };
}

export async function applyStockSettings(settings) {
  const resolved = resolveRequiredSettings(settings);
  const missing = [];
  if (!resolved.unique) missing.push("globally unique serials");
  if (!resolved.deleteSerialized) missing.push("delete serialized stock");
  if (missing.length) {
    throw new Error(
      `Required InvenTree settings not found: ${missing.join(", ")}. Keys on this instance:\n` +
        settings.map((row) => `  ${row.key} = ${row.value}  (${row.name ?? ""})`).join("\n"),
    );
  }

  await api("PATCH", `/api/settings/global/${resolved.unique.key}/`, { value: true });
  await api("PATCH", `/api/settings/global/${resolved.deleteSerialized.key}/`, { value: false });

  let editKey = null;
  if (resolved.editSerial) {
    await api("PATCH", `/api/settings/global/${resolved.editSerial.key}/`, { value: false });
    editKey = resolved.editSerial.key;
  }

  const after = await loadGlobalSettings();
  const uniqueAfter = after.find((row) => row.key === resolved.unique.key);
  const uniqueOn = ["true", "True", "1", true, 1].includes(uniqueAfter?.value);
  if (!uniqueOn) {
    throw new Error(`Failed to enable ${resolved.unique.key}: ${JSON.stringify(uniqueAfter)}`);
  }

  return {
    uniqueKey: resolved.unique.key,
    deleteSerializedKey: resolved.deleteSerialized.key,
    editSerialKey: editKey,
    warning: editKey
      ? null
      : "No serial-edit setting found on this instance. Confirm in Admin → Settings → Stock that SKUs cannot be edited.",
  };
}
