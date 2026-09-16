import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parsePhotoFilename } from "@floor/domain";
import { attachStockPhoto, floorLog, InventreeClient, loadUnitBySku } from "@floor/inventree";

export function dropDirs(root: string) {
  return {
    unmatched: join(root, "unmatched"),
    attached: join(root, "attached"),
  };
}

function ensureDir(path: string) {
  mkdirSync(path, { recursive: true });
}

function moveTo(dir: string, filePath: string) {
  ensureDir(dir);
  const name = basename(filePath);
  let dest = join(dir, name);
  if (existsSync(dest)) {
    dest = join(dir, `${Date.now()}-${name}`);
  }
  renameSync(filePath, dest);
  return dest;
}

export function listUnmatched(root: string): { name: string; path: string }[] {
  const dir = dropDirs(root).unmatched;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => {
      const path = join(dir, name);
      return statSync(path).isFile();
    })
    .map((name) => ({ name, path: join(dir, name) }));
}

export async function ingestDropFile(
  client: InventreeClient,
  dropRoot: string,
  filePath: string,
  actor: string,
): Promise<"attached" | "unmatched"> {
  const parsed = parsePhotoFilename(filePath);
  if (!parsed) {
    const dest = moveTo(dropDirs(dropRoot).unmatched, filePath);
    floorLog("photo_unmatched", { file: basename(filePath), dest, reason: "filename" });
    return "unmatched";
  }
  const unit = await loadUnitBySku(client, parsed.sku);
  if (!unit) {
    const dest = moveTo(dropDirs(dropRoot).unmatched, filePath);
    floorLog("photo_unmatched", { file: basename(filePath), dest, reason: "unknown_sku", sku: parsed.sku });
    return "unmatched";
  }
  await attachStockPhoto(client, {
    sku: parsed.sku,
    filename: basename(filePath),
    bytes: new Uint8Array(readFileSync(filePath)),
    actor,
  });
  moveTo(join(dropDirs(dropRoot).attached, parsed.sku), filePath);
  return "attached";
}

export async function ingestDropFolder(client: InventreeClient, dropRoot: string, actor: string) {
  if (!dropRoot || !existsSync(dropRoot)) {
    throw Object.assign(new Error("Photo drop folder is not set"), { status: 400 });
  }
  ensureDir(dropDirs(dropRoot).unmatched);
  ensureDir(dropDirs(dropRoot).attached);
  const names = readdirSync(dropRoot).filter((name) => {
    if (name === "unmatched" || name === "attached") return false;
    const path = join(dropRoot, name);
    return statSync(path).isFile();
  });
  const results: { file: string; status: string }[] = [];
  for (const name of names) {
    const status = await ingestDropFile(client, dropRoot, join(dropRoot, name), actor);
    results.push({ file: name, status });
  }
  return results;
}
