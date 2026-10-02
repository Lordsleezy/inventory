import { Environment } from "square/legacy";
import { squareClient } from "./square.mjs";

export function webSquareConfig(storeId) {
  const names = ["SQUARE_WEB_APPLICATION_ID", "SQUARE_WEB_LOCATION_ID", "SQUARE_WEB_ACCESS_TOKEN", "SQUARE_WEB_STORE_ID"];
  for (const name of names) if (!process.env[name]?.trim()) throw new Error(`missing_${name}`);
  if (storeId !== process.env.SQUARE_WEB_STORE_ID.trim()) throw new Error("web_store_not_allowed");
  if (process.env.SQUARE_WEB_APPLICATION_ID.startsWith("sandbox-")) throw new Error("production_square_required");
  return { application_id: process.env.SQUARE_WEB_APPLICATION_ID.trim(), location_id: process.env.SQUARE_WEB_LOCATION_ID.trim(), sandbox: false };
}

export function webSquareClient(storeId) {
  webSquareConfig(storeId);
  return squareClient(process.env.SQUARE_WEB_ACCESS_TOKEN.trim(), Environment.Production);
}
