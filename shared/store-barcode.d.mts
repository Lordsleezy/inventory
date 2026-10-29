export function isStoreLabelBarcode(raw: string): boolean;
export function isCompleteReceiveTitle(title: string, brand?: string): boolean;
export function storeLabelWarning(): string;


export function isNoBrand(brand: unknown): boolean;
export function receivePhotoIdentity<T extends Record<string, unknown>>(fields: T): T & { title: string; brand: string; no_brand: boolean; item_type: string };
