/** Match netlify/functions/employees.mjs signInEmail() for admin-created usernames. */
export function employeeSignInEmail(identifier: string): string | null {
  const raw = identifier.trim().toLowerCase();
  if (!raw) return null;
  if (raw.includes("@")) return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw : null;
  const slug = raw.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug ? slug + "@employees.floor.local" : null;
}
