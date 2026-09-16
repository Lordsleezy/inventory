#!/usr/bin/env node
/**
 * Create InvenTree users with generated strong passwords.
 * Staff log in with a 4–8 digit PIN; the PIN is never the Django password.
 */
import { randomBytes, scryptSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { api, rows } from "./http.mjs";

const root = join(fileURLToPath(new URL("../..", import.meta.url)));
const examplePath = join(root, "config", "staff.example.json");
const outPath = process.env.FLOOR_STAFF_FILE ?? join(root, "config", "staff.json");

function hashPin(pin) {
  if (!/^\d{4,8}$/.test(pin)) throw new Error(`PIN for provisioning must be 4–8 digits, got "${pin}"`);
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pin, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

function generatePassword() {
  return `${randomBytes(24).toString("base64url")}Aa1!`;
}

async function findUser(username) {
  const users = rows(await api("GET", `/api/user/?username=${encodeURIComponent(username)}`));
  return users.find((row) => row.username === username) ?? users[0] ?? null;
}

async function setPassword(userId, password) {
  const attempts = [
    { method: "POST", path: `/api/user/${userId}/set-password/`, body: { password } },
    { method: "PATCH", path: `/api/user/${userId}/`, body: { password } },
  ];
  let lastErr;
  for (const attempt of attempts) {
    try {
      await api(attempt.method, attempt.path, attempt.body);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`Could not set password for user ${userId}: ${lastErr?.message}`);
}

async function main() {
  const source = JSON.parse(readFileSync(examplePath, "utf8"));
  const staff = [];

  for (const row of source.staff) {
    if (!/^\d{4,8}$/.test(row.pin) || row.pin === "replace-at-provision") {
      throw new Error(
        `Set a real 4–8 digit PIN for ${row.username} in ${examplePath} (or copy to config/staff.seed.json) before provisioning.`,
      );
    }
    const password = generatePassword();
    let user = await findUser(row.username);
    if (!user) {
      user = await api("POST", "/api/user/", {
        username: row.username,
        email: `${row.username}@localhost`,
        first_name: row.displayName,
        is_active: true,
        is_staff: row.role === "admin",
        is_superuser: row.role === "admin",
      });
      console.log("created InvenTree user", row.username, user.pk);
    } else {
      console.log("InvenTree user exists", row.username, user.pk);
    }
    await setPassword(user.pk ?? user.id, password);
    staff.push({
      username: row.username,
      displayName: row.displayName,
      role: row.role,
      pinHash: hashPin(row.pin),
      inventreePassword: password,
    });
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ staff }, null, 2) + "\n", { encoding: "utf8" });
  console.log("wrote", outPath);
  console.log("PINs stay on the floor. InvenTree passwords are generated and stored only in that file.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
