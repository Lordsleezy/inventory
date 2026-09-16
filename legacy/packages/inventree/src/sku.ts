import { InventreeClient } from "./client.ts";
import { nextSkuFromSerials } from "./sku-math.ts";

export { nextSkuFromSerials } from "./sku-math.ts";

export async function nextSku(
  client: InventreeClient,
  skuStart: number,
  extraOccupied: Array<string | null | undefined> = [],
): Promise<string> {
  const stocks = await client.listAll<{ serial?: string | null }>("/api/stock/");
  return nextSkuFromSerials(
    [...stocks.map((row) => row.serial), ...extraOccupied],
    skuStart,
  );
}
