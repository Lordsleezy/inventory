/** Map staff display names / emails to canonical Books payout people. */
export type CanonicalPerson = 'paul' | 'jacob' | 'steve';

const PAUL = /\b(paul|admin)\b|admin@/i;
const JACOB = /\bjacob\b/i;
const STEVE = /\bsteve\b/i;

export function canonicalPersonKey(name: string, email?: string | null): CanonicalPerson | null {
  const blob = `${name} ${email || ''}`.trim();
  if (PAUL.test(blob)) return 'paul';
  if (JACOB.test(blob)) return 'jacob';
  if (STEVE.test(blob)) return 'steve';
  return null;
}

export function canonicalPersonLabel(key: CanonicalPerson): string {
  return ({ paul: 'Paul', jacob: 'Jacob', steve: 'Steve' } as const)[key];
}

export function mergeEmployeeIds(
  staff: { user_id: string; display_name: string; email?: string | null }[],
  peopleSlots: { slot: string; employee_id: string | null }[],
): { paulId: string | null; jacobId: string | null; steveId: string | null; aliasToCanonical: Map<string, CanonicalPerson> } {
  const aliasToCanonical = new Map<string, CanonicalPerson>();
  for (const s of staff) {
    const key = canonicalPersonKey(s.display_name, s.email);
    if (key) aliasToCanonical.set(s.user_id, key);
  }
  let paulId: string | null = null;
  let jacobId: string | null = null;
  let steveId: string | null = null;
  for (const p of peopleSlots) {
    if (p.slot === 'paul' && p.employee_id) paulId = p.employee_id;
    if (p.slot === 'jacob' && p.employee_id) jacobId = p.employee_id;
  }
  for (const [id, key] of aliasToCanonical) {
    if (key === 'paul' && !paulId) paulId = id;
    if (key === 'jacob' && !jacobId) jacobId = id;
    if (key === 'steve') steveId = id;
  }
  if (paulId) aliasToCanonical.set(paulId, 'paul');
  if (jacobId) aliasToCanonical.set(jacobId, 'jacob');
  if (steveId) aliasToCanonical.set(steveId, 'steve');
  return { paulId, jacobId, steveId, aliasToCanonical };
}
