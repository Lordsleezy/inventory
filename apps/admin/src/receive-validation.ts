export function receiveMissingFields({
  doNotList,
  brandReady,
  otherGaps = [],
  hasPhoto,
}: {
  doNotList: boolean;
  brandReady: boolean;
  otherGaps?: string[];
  hasPhoto: boolean;
}): string[] {
  if (doNotList) return brandReady ? [] : ['brand'];
  return [...otherGaps, ...(hasPhoto ? [] : ['photo'])];
}

export function notForSaleBrandError(doNotList: boolean, brandReady: boolean): string | null {
  return doNotList && !brandReady ? 'Brand required. Enter a brand or choose Unbranded.' : null;
}
