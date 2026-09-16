import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { generateInventreePassword, hashPin, verifyPin } from "./pin.ts";

export type StaffRole = "admin" | "staff";

export type StaffRecord = {
  username: string;
  displayName: string;
  role: StaffRole;
  pinHash: string;
  inventreePassword: string;
};

export type StaffFile = {
  staff: StaffRecord[];
};

export function loadStaffFile(path: string): StaffFile {
  return JSON.parse(readFileSync(path, "utf8")) as StaffFile;
}

export function saveStaffFile(path: string, file: StaffFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
}

export function upsertStaff(
  file: StaffFile,
  input: { username: string; displayName: string; role: StaffRole; pin: string },
): StaffRecord {
  const record: StaffRecord = {
    username: input.username,
    displayName: input.displayName,
    role: input.role,
    pinHash: hashPin(input.pin),
    inventreePassword: generateInventreePassword(),
  };
  const index = file.staff.findIndex((row) => row.username === input.username);
  if (index >= 0) file.staff[index] = record;
  else file.staff.push(record);
  return record;
}

export function unlockWithPin(file: StaffFile, username: string, pin: string): StaffRecord | null {
  const record = file.staff.find((row) => row.username === username);
  if (!record) return null;
  if (!verifyPin(pin, record.pinHash)) return null;
  return record;
}
