const DEFAULT_CONFIG = Object.freeze({
  updatedAt: '2026-10-05',
  marketplaces: {
    ebay: { rate: 0.136, fixedFeeCents: 40, labelPaidBySeller: true },
    mercari: { rate: 0.10, fixedFeeCents: 0, labelPaidBySeller: true },
    whatnot: { rate: 0.109, fixedFeeCents: 30, labelPaidBySeller: false },
    depop: { rate: 0.033, fixedFeeCents: 45, labelPaidBySeller: false },
    website: { rate: 0, fixedFeeCents: 0, labelPaidBySeller: false },
  },
});

const CHANNELS = ['ebay', 'mercari', 'whatnot', 'depop', 'website'];
const deepMerge = (base, override) => ({
  ...base,
  ...override,
  marketplaces: Object.fromEntries(CHANNELS.map((key) => [key, {
    ...base.marketplaces[key],
    ...(override?.marketplaces?.[key] || {}),
  }])),
});

export function getFeeConfig() {
  const raw = process.env.MARKETPLACE_FEE_CONFIG;
  if (!raw) return structuredClone(DEFAULT_CONFIG);
  let override;
  try { override = JSON.parse(raw); }
  catch { throw new Error('MARKETPLACE_FEE_CONFIG must be valid JSON'); }
  const config = deepMerge(DEFAULT_CONFIG, override);
  for (const key of CHANNELS) {
    const fee = config.marketplaces[key];
    if (!Number.isFinite(Number(fee.rate)) || Number(fee.rate) < 0 || Number(fee.rate) >= 1
      || !Number.isInteger(Number(fee.fixedFeeCents)) || Number(fee.fixedFeeCents) < 0) {
      throw new Error(`Invalid fee configuration for ${key}`);
    }
  }
  if (typeof config.updatedAt !== 'string' || !config.updatedAt) config.updatedAt = DEFAULT_CONFIG.updatedAt;
  return config;
}

function roundUpTo99(cents) {
  const value = Math.max(0, Math.ceil(Number(cents)));
  return Math.floor(value / 100) * 100 + 99;
}

export function calcListPrice(floorCents, marketplace, labelCostCents = 0, packingMarkupCents = 0) {
  const channel = String(marketplace).toLowerCase();
  if (!CHANNELS.includes(channel)) throw new Error(`Unsupported marketplace: ${marketplace}`);
  const floor = Number(floorCents), label = Number(labelCostCents) || 0, markup = Number(packingMarkupCents) || 0;
  if (![floor, label, markup].every(Number.isFinite) || floor < 0 || label < 0 || markup < 0) {
    throw new Error('Price inputs must be nonnegative cents');
  }
  if (channel === 'website') return Math.round(floor);
  const fee = getFeeConfig().marketplaces[channel];
  const netTarget = floor + markup;
  let gross;
  if (channel === 'ebay') gross = (netTarget + label + fee.fixedFeeCents) / (1 - fee.rate);
  else if (channel === 'mercari') gross = (netTarget + label) / (1 - fee.rate);
  else gross = (netTarget + fee.fixedFeeCents) / (1 - fee.rate);
  return roundUpTo99(gross);
}

const n = (v) => {
  const value = Number(v);
  return Number.isFinite(value) && value > 0 ? value : null;
};

export function estimateLabelCost(unit = {}) {
  const specs = unit.listing_specs && typeof unit.listing_specs === 'object' ? unit.listing_specs : {};
  const weightLb = n(unit.package_weight_lb)
    ?? (n(unit.package_weight_oz ?? specs.package_weight_oz) ? n(unit.package_weight_oz ?? specs.package_weight_oz) / 16 : null)
    ?? n(specs.package_weight_lb);
  const dims = [unit.package_length_in, unit.package_width_in, unit.package_height_in].map(n);
  const completePackage = weightLb != null && dims.every((x) => x != null);
  const categoryText = [unit.category, unit.title, unit.brand, unit.model,
    specs.ebay_aspects?.Game, specs.ebay_aspects?.Type].filter(Boolean).join(' ').toLowerCase();
  const flatItem = /trading.?cards?|\btcg\b|baseball card|pokemon|pok[eé]mon|comic|postcard|flat item/.test(categoryText);
  const smallToy = /figure|toy|transformer|gundam|doll|action figure|ranger|vehicle/.test(categoryText);

  let cents = 1000;
  if (weightLb != null && weightLb > 5) cents = 1800;
  else if (weightLb != null && weightLb >= 2) cents = 1200;
  else if (flatItem && (weightLb == null || weightLb < 1)) cents = 500;
  else if (smallToy && (weightLb == null || weightLb < 2)) cents = 800;
  return {
    labelCostCents: cents,
    isEstimate: true,
    missingPackageData: !completePackage,
  };
}

export const feeConfigUpdatedAt = () => getFeeConfig().updatedAt;
