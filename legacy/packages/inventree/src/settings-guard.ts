import { InventreeClient } from "./client.ts";
import { floorLog } from "./log.ts";

export const DELETE_SERIALIZED_KEY = "STOCK_ALLOW_DELETE_SERIALIZED";

function isOn(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true" || value === "True";
}

async function readDeleteSerialized(client: InventreeClient): Promise<{ pk?: number; key: string; value: unknown }> {
  const row = await client.get<{ pk?: number; key?: string; value?: unknown }>(
    `/api/settings/global/${DELETE_SERIALIZED_KEY}/`,
  );
  return { pk: row.pk, key: row.key ?? DELETE_SERIALIZED_KEY, value: row.value };
}

async function writeDeleteSerialized(client: InventreeClient, value: boolean, reason: string) {
  floorLog("delete_serialized_flip", { key: DELETE_SERIALIZED_KEY, to: value, reason });
  await client.patch(`/api/settings/global/${DELETE_SERIALIZED_KEY}/`, { value });
}

/**
 * Startup rail: serialized delete must stay off. If a crashed hard-delete
 * left it on, force it off and shout.
 */
export async function assertDeleteSerializedOff(client: InventreeClient): Promise<void> {
  const row = await readDeleteSerialized(client);
  if (isOn(row.value)) {
    floorLog("delete_serialized_found_on", {
      key: DELETE_SERIALIZED_KEY,
      value: row.value,
      action: "forcing_false",
    });
    await writeDeleteSerialized(client, false, "startup_assertion");
    const after = await readDeleteSerialized(client);
    if (isOn(after.value)) {
      throw new Error(
        `${DELETE_SERIALIZED_KEY} is ON and could not be forced off. Refusing to start. Set it false in InvenTree before opening Floor.`,
      );
    }
    return;
  }
  floorLog("delete_serialized_ok", { key: DELETE_SERIALIZED_KEY, value: row.value });
}

/**
 * Momentary unlock for admin hard-delete. Always restores false in finally.
 * Startup assertion exists because a crash here can leave the rail off.
 */
export async function withDeleteSerializedAllowed<T>(
  client: InventreeClient,
  fn: () => Promise<T>,
): Promise<T> {
  await readDeleteSerialized(client);
  await writeDeleteSerialized(client, true, "hard_delete");
  try {
    return await fn();
  } finally {
    try {
      await writeDeleteSerialized(client, false, "hard_delete_finally");
    } catch (err) {
      floorLog("delete_serialized_flip_restore_failed", {
        key: DELETE_SERIALIZED_KEY,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
