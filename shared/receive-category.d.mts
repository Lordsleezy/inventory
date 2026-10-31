export function categoryChoices(value: unknown): string[];
export function filterCategoryOptions(list: unknown, query?: string): string[];
export function isMattressAccessory(text: unknown): boolean;
export function beddingCategoryName(list: unknown): string;
export function matchReceiveCategory(list: unknown, hints?: {
  category?: string | null;
  title?: string | null;
  brand?: string | null;
  model?: string | null;
}): string;
