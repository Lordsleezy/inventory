export type TempFlatHold = {
  active?: boolean;
  buyer?: string;
  expires_at?: string;
  reverted_at?: string | null;
  revert_reason?: string | null;
  kept?: { sku?: string; title?: string };
  items?: { sku?: string; title?: string }[];
};

export function tempFlatLine(hold: TempFlatHold | null | undefined): string;
