import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseFloorConfig, type FloorConfig } from "@floor/domain";
import { floorRoot } from "./inventree";

export function floorConfigPath() {
  return join(floorRoot(), "config", "floor.json");
}

export function loadFloorConfig(): FloorConfig {
  const path = floorConfigPath();
  const example = join(floorRoot(), "config", "floor.example.json");
  if (!existsSync(path) && existsSync(example)) {
    mkdirSync(join(floorRoot(), "config"), { recursive: true });
    writeFileSync(path, readFileSync(example, "utf8"));
  }
  if (!existsSync(path)) return parseFloorConfig({});
  return parseFloorConfig(JSON.parse(readFileSync(path, "utf8")));
}

export function saveFloorConfig(config: FloorConfig) {
  mkdirSync(join(floorRoot(), "config"), { recursive: true });
  writeFileSync(floorConfigPath(), JSON.stringify(config, null, 2) + "\n");
}
