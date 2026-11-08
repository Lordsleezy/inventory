type AspectDef = { name: string; required?: boolean; allowed?: string[]; selection_only?: boolean };

export type ReceiveFieldKey =
  | 'photo'
  | 'quantity'
  | 'condition'
  | 'brand'
  | 'category'
  | 'ebay_category'
  | 'ebay_aspects'
  | 'price'
  | 'upc'
  | 'title';

export function receiveMissingFields({
  doNotList,
  brandReady,
  otherGaps = [],
  hasPhoto,
  quantityOk = true,
}: {
  doNotList: boolean;
  brandReady: boolean;
  otherGaps?: string[];
  hasPhoto: boolean;
  quantityOk?: boolean;
}): string[] {
  if (doNotList) {
    const out: string[] = [];
    if (!hasPhoto) out.push('photo');
    if (!quantityOk) out.push('quantity');
    return out;
  }
  const out = [...otherGaps];
  if (!quantityOk && !out.includes('quantity')) out.unshift('quantity');
  if (!hasPhoto) out.push('photo');
  return out;
}

export function notForSaleBrandError(_doNotList: boolean, _brandReady: boolean): string | null {
  return null;
}

export function aspectFilled(def: AspectDef, attributes: Record<string, string>, na: Record<string, boolean>) {
  if (na[def.name]) return true;
  const v = (attributes[def.name] || '').trim();
  if (!v) return false;
  if (def.selection_only && def.allowed?.length) return def.allowed.includes(v);
  return true;
}

export function missingEbayAspects(fields: AspectDef[], attributes: Record<string, string>, na: Record<string, boolean>) {
  return fields.filter(f => f.required && !aspectFilled(f, attributes, na)).map(f => f.name);
}

export function upcRequired(channels: string[]) {
  return channels.includes('amazon') || channels.includes('tiktok');
}

export function receiveFieldMessage(key: ReceiveFieldKey): string {
  const map: Record<ReceiveFieldKey, string> = {
    photo: 'Add at least one photo',
    quantity: 'Enter quantity',
    condition: 'Select condition',
    brand: "Enter a brand or tick 'No brand'",
    category: 'Pick a category',
    ebay_category: 'Pick a category',
    ebay_aspects: 'Fill required item specifics',
    price: 'Enter price',
    upc: 'Enter UPC or tick No UPC',
    title: 'Enter a title',
  };
  return map[key] || 'Required';
}
