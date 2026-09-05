export type Page<T> = {
  items: T[];
  next: string | null;
};

/**
 * InvenTree 1.5 list endpoints return either a raw array or a paginated
 * { results, next } object. This is the only place that distinction is handled.
 */
export function normalizeList<T>(data: unknown): Page<T> {
  if (Array.isArray(data)) {
    return { items: data as T[], next: null };
  }
  if (data !== null && typeof data === "object" && Array.isArray((data as { results?: unknown }).results)) {
    const page = data as { results: T[]; next?: string | null };
    return { items: page.results, next: page.next ?? null };
  }
  throw new Error(
    `Unexpected InvenTree list payload (${data === null ? "null" : typeof data}). Expected an array or { results: [] }.`,
  );
}

export function recordId(record: { pk?: number; id?: number } | null | undefined): number {
  const id = record?.pk ?? record?.id;
  if (id === undefined || id === null) {
    throw new Error("InvenTree record has no pk/id");
  }
  return id;
}
