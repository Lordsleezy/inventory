import { readFileSync } from "node:fs";
import { tabletModeFromProc } from "@floor/domain";

const DEVICES = "/proc/bus/input/devices";

export function isTabletMode(): boolean {
  try {
    return tabletModeFromProc(readFileSync(DEVICES, "utf8"));
  } catch {
    return false;
  }
}
