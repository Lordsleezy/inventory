export const PROTECTED_ADMIN_EMAIL = "admin@admin.com";

export type CommissionPerson = { user_id: string; display_name: string };
export type CommissionRule = { employee_id: string; rate: number };

const FIRST = ["steve", "paul", "jacob"];

function score(person: CommissionPerson, rules: CommissionRule[]) {
  const rule = rules.find((row) => row.employee_id === person.user_id);
  return rule && Number(rule.rate) > 0 ? Number(rule.rate) : 0;
}

/** One row per name. The protected admin login is not a commission person. */
export function peopleForCommission<T extends CommissionPerson>(
  staff: T[],
  rules: CommissionRule[],
  emailById: Map<string, string | null | undefined>,
): T[] {
  const visible = staff.filter((person) => {
    const email = String(emailById.get(person.user_id) || "").trim().toLowerCase();
    if (email === PROTECTED_ADMIN_EMAIL) return false;
    if (!email && person.display_name.trim().toLowerCase() === "admin") return false;
    return true;
  });
  const best = new Map<string, T>();
  for (const person of visible) {
    const key = person.display_name.trim().toLowerCase();
    const prev = best.get(key);
    if (!prev || score(person, rules) > score(prev, rules)) best.set(key, person);
  }
  return [...best.values()].sort((a, b) => {
    const ai = FIRST.indexOf(a.display_name.trim().toLowerCase());
    const bi = FIRST.indexOf(b.display_name.trim().toLowerCase());
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    return a.display_name.localeCompare(b.display_name);
  });
}

export function showsOnPayouts(employeeId: string, rules: CommissionRule[], onlineEmployeeId: string | null) {
  const rule = rules.find((row) => row.employee_id === employeeId);
  if (rule && Number(rule.rate) > 0) return true;
  return Boolean(onlineEmployeeId) && employeeId === onlineEmployeeId;
}
