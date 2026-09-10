import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isSafeStoredReceiptName } from "@floor/domain";
import { floorRoot } from "./inventree";

export function saleReceiptDir(soId: number) {
  return join(floorRoot(), "data", "receipts", String(soId));
}

export function saleReceiptPath(soId: number, storedName: string) {
  if (!Number.isInteger(soId) || soId < 1 || !isSafeStoredReceiptName(storedName)) {
    throw Object.assign(new Error("Bad receipt file"), { status: 400 });
  }
  return join(saleReceiptDir(soId), storedName);
}

export function writeSaleReceiptBytes(soId: number, storedName: string, bytes: Uint8Array) {
  mkdirSync(saleReceiptDir(soId), { recursive: true });
  writeFileSync(saleReceiptPath(soId, storedName), bytes);
}

export function readSaleReceiptBytes(soId: number, storedName: string) {
  const path = saleReceiptPath(soId, storedName);
  if (!existsSync(path)) throw Object.assign(new Error("No receipt uploaded"), { status: 404 });
  return readFileSync(path);
}

export function deleteSaleReceiptBytes(soId: number, storedName: string | null) {
  if (!storedName) return;
  const path = saleReceiptPath(soId, storedName);
  if (existsSync(path)) unlinkSync(path);
}
