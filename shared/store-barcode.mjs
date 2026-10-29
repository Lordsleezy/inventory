/** Retail/in-store barcode prefixes are not stable manufacturer identifiers. */
export function isStoreLabelBarcode(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return (digits.length === 12 && digits.startsWith('49'))
    || (digits.length >= 8 && digits.length <= 14 && digits.startsWith('2'));
}

export function isNoBrand(brand) {
  return /^(unbranded|no[ _-]?brand|none|unknown|n\/?a)?$/i.test(String(brand || '').trim());
}

/** Reject AI-generated stubs such as "ACHIM Rustic" before they reach a saved unit. */
export function isCompleteReceiveTitle(title, brand = '') {
  const value = String(title || '').trim().replace(/\s+/g, ' ');
  const words = value.match(/[A-Za-z0-9]+(?:[’'-][A-Za-z0-9]+)*/g) || [];
  if (value.length < 24 || words.length < 4) return false;
  if (!isNoBrand(brand) && !value.toLocaleLowerCase().includes(String(brand).trim().toLocaleLowerCase())) return false;
  return true;
}

export function storeLabelWarning() {
  return 'This looks like a store sticker. Scan the manufacturer barcode if there is one.';
}


/** Only infer the item type from the supplied title, never from a brand/style stub. */
export function receivePhotoIdentity(fields = {}) {
  const no_brand = fields.no_brand === true || isNoBrand(fields.brand);
  const title = String(fields.title || '').trim();
  const brand = no_brand ? 'Unbranded' : String(fields.brand || '').trim();
  let inferred = title.split(/[,;]/)[0].trim();
  if (!no_brand && inferred.toLowerCase().startsWith(brand.toLowerCase() + ' ')) inferred = inferred.slice(brand.length).trim();
  const item_type = String(fields.item_type || '').trim() || (isCompleteReceiveTitle(title, brand) ? inferred : '');
  return { ...fields, title, brand, no_brand, item_type };
}
