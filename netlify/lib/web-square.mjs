import { Environment } from "square/legacy";
import { squareClient } from "./square.mjs";

/** Website checkout uses its own Square credentials (not register OAuth). SQUARE_WEB_ENV picks sandbox or production. */
const NAMES = {
  production: ["SQUARE_WEB_APPLICATION_ID", "SQUARE_WEB_LOCATION_ID", "SQUARE_WEB_ACCESS_TOKEN"],
  sandbox: ["SQUARE_WEB_SANDBOX_APPLICATION_ID", "SQUARE_WEB_SANDBOX_LOCATION_ID", "SQUARE_WEB_SANDBOX_ACCESS_TOKEN"],
};

export function webSquareEnv() {
  return (process.env.SQUARE_WEB_ENV || "").trim().toLowerCase() === "production" ? "production" : "sandbox";
}

export function webSquareConfig(storeId, env = webSquareEnv()) {
  const names = NAMES[env === "production" ? "production" : "sandbox"];
  for (const name of [...names, "SQUARE_WEB_STORE_ID"]) if (!process.env[name]?.trim()) throw new Error(`missing_${name}`);
  if (storeId !== process.env.SQUARE_WEB_STORE_ID.trim()) throw new Error("web_store_not_allowed");
  const applicationId = process.env[names[0]].trim();
  if (env === "production" && applicationId.startsWith("sandbox-")) throw new Error("production_square_required");
  if (env !== "production" && !applicationId.startsWith("sandbox-")) throw new Error("sandbox_square_required");
  return { application_id: applicationId, location_id: process.env[names[1]].trim(), sandbox: env !== "production", env: env === "production" ? "production" : "sandbox" };
}

export function webSquareClient(storeId, env = webSquareEnv()) {
  const cfg = webSquareConfig(storeId, env);
  const token = process.env[NAMES[cfg.env][2]].trim();
  return squareClient(token, cfg.sandbox ? Environment.Sandbox : Environment.Production);
}
