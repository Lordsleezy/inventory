export type CategorySuggestion = {
  category_id: string;
  category_name: string;
  path: string;
  best_match?: boolean;
};

export type AspectField = {
  name?: string;
  required?: boolean;
  allowed?: string[];
  selection_only?: boolean;
  selectionOnly?: boolean;
  multi?: boolean;
  maxLength?: number;
  max_length?: number;
};

export function suggestionIsSane(title: string, row: unknown): boolean;
export function presentCategorySuggestions(title: string, rows: unknown[]): CategorySuggestion[];
export function confidentCategory(title: string, rows: unknown[]): CategorySuggestion | null;
export function missingAspectNames(fields: AspectField[], attributes: Record<string, string>): string[];
export function ebayDetailsStatus(input: {
  categoryId?: string;
  fields?: AspectField[];
  attributes?: Record<string, string>;
  conditionAllowed?: boolean;
}): { ready: boolean; tone: string; text: string };
export function legacyCategoryRank(paths: string[], query: string): { path: string; score: number; mainstream: number }[];
