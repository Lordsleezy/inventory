export function digitsOnly(value: string | null | undefined): string;
export function alphaNumOnly(value: string | null | undefined): string;
export function isPostagePermitId(value: string | null | undefined): boolean;
export function isLikelySkuLine(text: string | null | undefined): boolean;
export function uspsCheckDigitValid(number: string | null | undefined): boolean;
export function ups1ZValid(value: string | null | undefined): boolean;
export function completeUspsFromBody(digits: string | null | undefined): string | null;
export function fedExValid(value: string | null | undefined): boolean;
export function classifyCarrier(number: string | null | undefined): string | null;
export function validateTrackingCandidate(
  number: string | null | undefined,
  opts?: { nearTrackingLabel?: boolean },
): { number: string; carrier: string; score: number } | null;
