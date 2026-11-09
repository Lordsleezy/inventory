import { missingAspectNames } from '../../../shared/ebay-category-present.mjs';

type AspectDef = { name: string; required?: boolean; allowed?: string[]; selection_only?: boolean; multi?: boolean; maxLength?: number };

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
  | 'title'
  | 'dimensions'
  | 'location';

/** Defective or Do not list waives the photo and the dimensions. Either flag is enough. */
export function receiveMediaWaived(doNotList: boolean, defective: boolean) {
  return doNotList || defective;
}

export function receiveMissingFields({
  doNotList,
  brandReady,
  otherGaps = [],
  hasPhoto,
  quantityOk = true,
  defective = false,
  hasDimensions = true,
  hasLocation = true,
  titleOnly = false,
  titleReady = true,
}: {
  doNotList: boolean;
  brandReady: boolean;
  otherGaps?: string[];
  hasPhoto: boolean;
  quantityOk?: boolean;
  defective?: boolean;
  hasDimensions?: boolean;
  hasLocation?: boolean;
  /** Staff DNL: a title is the only field. */
  titleOnly?: boolean;
  titleReady?: boolean;
}): string[] {
  void brandReady;
  const waive = receiveMediaWaived(doNotList, defective);
  if (doNotList) {
    const out: string[] = [];
    if (titleOnly && !titleReady) out.push('title');
    if (!quantityOk) out.push('quantity');
    return out;
  }
  const out = [...otherGaps];
  if (!quantityOk && !out.includes('quantity')) out.unshift('quantity');
  if (!waive && !hasDimensions && !out.includes('dimensions')) out.push('dimensions');
  if (!waive && !hasPhoto && !out.includes('photo')) out.push('photo');
  if (!hasLocation && !out.includes('location')) out.push('location');
  return out;
}

export function notForSaleBrandError(_doNotList: boolean, _brandReady: boolean): string | null {
  return null;
}

export function aspectFilled(def: AspectDef, attributes: Record<string, string>, _na: Record<string, boolean> = {}) {
  return !missingAspectNames([def], attributes).length && Boolean((attributes[def.name] || '').trim());
}

export function missingEbayAspects(fields: AspectDef[], attributes: Record<string, string>, _na: Record<string, boolean> = {}) {
  return missingAspectNames(fields, attributes);
}

export function upcRequired(channels: string[]) {
  return channels.includes('amazon') || channels.includes('tiktok');
}

export function receiveFieldMessage(key: ReceiveFieldKey): string {
  const map: Record<ReceiveFieldKey, string> = {
    photo: 'Add a photo you took or chose',
    quantity: 'Enter quantity',
    condition: 'Select condition',
    brand: "Enter a brand or tick 'No brand'",
    category: 'Pick a category',
    ebay_category: 'Pick a category',
    ebay_aspects: 'Fill required item specifics',
    price: 'Enter price',
    upc: 'Enter UPC or tick No UPC',
    title: 'Enter a title',
    dimensions: 'Enter length, width, height, and weight',
    location: 'Pick a location',
  };
  return map[key] || 'Required';
}

/** Which accordion section a missing-field key belongs to. */
export function receiveSectionForGap(gap: string): string {
  const key = gap.toLowerCase();
  if (key.includes('photo')) return 'photos';
  if (key.includes('dimension') || key === 'spec' || key.includes('weight') || key.includes('size')) return 'size';
  if (key.includes('location')) return 'location';
  if (key.includes('price') || key.includes('condition') || key.includes('quantity')) return 'price';
  if (key.includes('upc')) return 'upc';
  if (key === 'store category') return 'details';
  return 'item';
}
