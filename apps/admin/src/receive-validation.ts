import type { AspectDef } from './aspectOptions';
import { valueIsValid } from './aspectOptions';

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
}: {
  doNotList: boolean;
  brandReady: boolean;
  otherGaps?: string[];
  hasPhoto: boolean;
}): string[] {
  if (doNotList) {
    const out: string[] = [];
    if (!hasPhoto) out.push('photo');
    return out;
  }
  return [...otherGaps, ...(hasPhoto ? [] : ['photo'])];
}

export function notForSaleBrandError(_doNotList: boolean, _brandReady: boolean): string | null {
  return null;
}

export function aspectFilled(def: AspectDef, attributes: Record<string, string>, na: Record<string, boolean>) {
  if (na[def.name]) return true;
  const v = (attributes[def.name] || '').trim();
  if (!v) return false;
  return valueIsValid(def, v);
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
