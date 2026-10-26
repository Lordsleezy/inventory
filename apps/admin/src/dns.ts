/** DNS items stay store/pickup-only and never go to eBay, Amazon, TikTok or Depop. */
export function isDnsType(item: { brand?: unknown; model?: unknown; title?: unknown; category?: unknown; internal_category?: unknown }): boolean {
  const identity = [item.brand, item.model, item.title, item.category, item.internal_category].filter(Boolean).join(' ');
  const product = [item.brand, item.model, item.title].filter(Boolean).join(' ');
  return /\b(refrigerators?|fridges?|freezers?|dishwashers?|deep\s*fryers?|mattress(?:es)?|bed\s*frames?|sofas?|couches|couch|scooters?)\b/i.test(identity)
    && !/\b(filters?|covers?|protectors?|pads?|sheets?|hoses?|parts?|magnets?|pillows?|cushions?|toys?|dollhouse)\b/i.test(product);
}
