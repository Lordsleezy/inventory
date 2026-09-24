export function isStaffApp(): boolean {
  return String(import.meta.env.VITE_FLOOR_FLAVOR || "").toLowerCase() === "staff";
}

export function showAdminUi(role: string): boolean {
  if (isStaffApp()) return false;
  return role === "owner" || role === "manager";
}
