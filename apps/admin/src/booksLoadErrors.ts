import type { BooksSpan } from './books/booksSpan';

export function loadErrorMessage(e: unknown, span: BooksSpan): string {
  const raw = e && typeof e === 'object' && 'message' in e ? String((e as { message: string }).message) : String(e);
  if (/portal_access_denied|42501/i.test(raw)) {
    return 'You do not have permission to open Books for this store. Ask an admin to confirm your owner or admin access.';
  }
  if (/period_not_found/i.test(raw)) return 'That month was not found. Pick another month or refresh the list.';
  return span === 'month' ? `Could not load this month: ${raw}` : `Could not load this report: ${raw}`;
}
