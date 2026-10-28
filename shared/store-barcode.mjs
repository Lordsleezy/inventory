/** Retail/in-store barcode prefixes are not stable manufacturer identifiers. */
export function isStoreLabelBarcode(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return (digits.length === 12 && digits.startsWith('49'))
    || (digits.length >= 8 && digits.length <= 14 && digits.startsWith('2'));
}

/** Reject AI-generated stubs such as "ACHIM Rustic" before they reach a saved unit. */
export function isCompleteReceiveTitle(title, brand = '') {
  const value = String(title || '').trim().replace(/\s+/g, ' ');
  const words = value.match(/[A-Za-z0-9]+(?:[’'-][A-Za-z0-9]+)*/g) || [];
  if (value.length < 24 || words.length < 4) return false;
  if (brand && !value.toLocaleLowerCase().includes(String(brand).trim().toLocaleLowerCase())) return false;
  return true;
}

export function storeLabelWarning() {
  return 'This looks like a store sticker. Scan the manufacturer barcode if there is one.';
}
