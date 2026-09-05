export function parsePhotoFilename(name: string): { sku: string } | null {
  const base = (name.split(/[/\\]/).pop() ?? name).trim();
  const match = base.match(/^(\d{5})(?:[-_].+)?\.(jpe?g|png|webp|gif)$/i);
  if (!match) return null;
  return { sku: match[1] };
}
