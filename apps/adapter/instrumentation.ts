import { InventreeClient, assertDeleteSerializedOff, fetchToken } from "@floor/inventree";

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const url = process.env.INVENTREE_URL;
  const user = process.env.INVENTREE_ADMIN_USER ?? "admin";
  const pass = process.env.INVENTREE_ADMIN_PASSWORD;
  if (!url || !pass) {
    console.warn(JSON.stringify({ src: "floor", event: "startup_skip_delete_serialized_assert", reason: "missing INVENTREE_URL or password" }));
    return;
  }
  const token = await fetchToken(url.replace(/\/$/, ""), user, pass);
  const client = new InventreeClient({ baseUrl: url.replace(/\/$/, ""), token });
  await assertDeleteSerializedOff(client);
}
