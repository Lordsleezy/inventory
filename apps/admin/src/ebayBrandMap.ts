/** Map Floor's brand field into the eBay "Brand" item specific. */

type AspectLike = { name: string; required?: boolean };

export function ebayBrandFieldName(fields: AspectLike[]): string | null {
  const hit = fields.find(field => /^brand$/i.test(String(field.name || '').trim()));
  if (hit) return hit.name;
  // Fields not loaded yet — still seed Brand so a save cannot drop it.
  if (!fields.length) return 'Brand';
  return null;
}

/** Copy Floor brand into attributes.Brand when that aspect is blank. */
export function withFloorBrandOnEbay(
  attributes: Record<string, string>,
  fields: AspectLike[],
  brand: string,
): Record<string, string> {
  const key = ebayBrandFieldName(fields);
  if (!key) return attributes;
  const value = String(brand || '').trim();
  if (!value) return attributes;
  if (String(attributes[key] || '').trim()) return attributes;
  return { ...attributes, [key]: value };
}
