/** Match netlify/functions/employees.mjs signInEmail() for admin-created usernames. */
export function employeeSignInEmail(identifier: string): string | null {
  const raw = identifier.trim().toLowerCase();
  if (!raw) return null;
  if (raw.includes("@")) return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw : null;
  const slug = raw.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug ? slug + "@employees.floor.local" : null;
}

/** Clock numbers may live on staff.floor.local with a floor+PIN secret. */
export function staffSignInAttempts(
  identifier: string,
  secret: string,
): { email: string; password: string }[] {
  const raw = identifier.trim();
  const pin = secret.trim();
  const out: { email: string; password: string }[] = [];
  function add(email: string, password: string) {
    if (!email || !password) return;
    if (out.some((row) => row.email === email && row.password === password)) return;
    out.push({ email, password });
  }
  const mapped = employeeSignInEmail(raw);
  if (mapped) add(mapped, pin);
  if (/^\d{4,8}$/.test(raw)) {
    add(`${raw}@staff.floor.local`, pin.length < 6 ? `floor${pin}` : pin);
    add(`${raw}@staff.floor.local`, pin);
    add(`${raw}@employees.floor.local`, pin);
  }
  return out;
}
