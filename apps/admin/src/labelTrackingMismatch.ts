function formatUspsGroups(number: string) {
  const d = String(number || '').replace(/\D/g, '');
  if (d.length < 12) return d;
  const parts: string[] = [];
  for (let i = 0; i < d.length; i += 4) parts.push(d.slice(i, i + 4));
  return parts.join(' ');
}

export type LabelMismatchParts = {
  kind: 'mismatch';
  label: string;
  marketplace: string;
  labelGrouped: string;
  marketplaceGrouped: string;
};

export function parseLabelMismatch(exception?: string | null): LabelMismatchParts | null {
  const raw = String(exception || '');
  if (!raw.startsWith('label_mismatch|')) {
    const legacy = raw.match(/Uploaded label (\d+) does not match eBay (\d+)/i);
    if (legacy) {
      return {
        kind: 'mismatch',
        label: legacy[1],
        marketplace: legacy[2],
        labelGrouped: formatUspsGroups(legacy[1]),
        marketplaceGrouped: formatUspsGroups(legacy[2]),
      };
    }
    return null;
  }
  const [, label, marketplace] = raw.split('|');
  if (!label || !marketplace) return null;
  return {
    kind: 'mismatch',
    label,
    marketplace,
    labelGrouped: formatUspsGroups(label),
    marketplaceGrouped: formatUspsGroups(marketplace),
  };
}
