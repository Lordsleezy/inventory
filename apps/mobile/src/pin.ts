import { floorCloud } from "@floor/cloud";

export async function askManagerPin(action: string, sku: string): Promise<string> {
  const pin = window.prompt("Manager PIN required");
  if (!pin) throw new Error("Manager PIN cancelled");
  const { data, error } = await floorCloud().rpc("approve_with_pin", {
    p_action: action,
    p_sku: sku,
    p_pin: pin,
  });
  if (error) {
    if (/pin_locked/i.test(error.message)) throw new Error("PIN locked after 5 tries. Wait a few minutes.");
    if (/pin_wrong/i.test(error.message)) throw new Error("Wrong PIN.");
    throw new Error(error.message);
  }
  return data as string;
}
