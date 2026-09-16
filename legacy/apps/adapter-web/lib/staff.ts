import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { unlockWithPin, type StaffFile } from "@floor/auth";
import { floorRoot, tokenForInventreeUser } from "./inventree";
import type { FloorRole, FloorSession } from "./session";

export type StaffTile = {
  username: string;
  displayName: string;
  role: FloorRole;
};

function staffFilePath() {
  return join(floorRoot(), "config", "staff.json");
}

export function listStaffTiles(): StaffTile[] {
  const path = staffFilePath();
  if (existsSync(path)) {
    const file = JSON.parse(readFileSync(path, "utf8")) as StaffFile;
    return file.staff.map((row) => ({
      username: row.username,
      displayName: row.displayName,
      role: row.role,
    }));
  }
  return [{ username: "admin", displayName: "Admin", role: "admin" }];
}

export async function loginWithPin(username: string, pin: string): Promise<FloorSession> {
  const path = staffFilePath();
  if (existsSync(path)) {
    const file = JSON.parse(readFileSync(path, "utf8")) as StaffFile;
    const record = unlockWithPin(file, username, pin);
    if (!record) throw Object.assign(new Error("Wrong PIN"), { status: 401 });
    const token = await tokenForInventreeUser(record.username, record.inventreePassword);
    return {
      token,
      username: record.username,
      displayName: record.displayName,
      role: record.role,
    };
  }

  const devPin = process.env.FLOOR_DEV_PIN;
  const adminUser = process.env.INVENTREE_ADMIN_USER ?? "admin";
  const adminPass = process.env.INVENTREE_ADMIN_PASSWORD;
  if (!devPin || !adminPass || username !== adminUser || pin !== devPin) {
    throw Object.assign(new Error("Wrong PIN"), { status: 401 });
  }
  const token = await tokenForInventreeUser(adminUser, adminPass);
  return { token, username: adminUser, displayName: "Admin", role: "admin" };
}
