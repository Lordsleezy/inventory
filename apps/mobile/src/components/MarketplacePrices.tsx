import { useState } from 'react';
import { floorCloud } from '@floor/cloud';
import { formatCents } from '@floor/store';

const base = (import.meta.env.VITE_FUNCTIONS_URL || 'https://inventoryobi.netlify.app').replace(/\/$/, '');
const channels = [['ebay', 'eBay'], ['mercari', 'Mercari'], ['whatnot', 'Whatnot'], ['depop', 'Depop'], ['website', 'Website']] as const;
type PriceData = { prices: Record<string, number>; label_estimate_cents: number; missing_package_data: boolean };

export function MarketplacePrices({ sku }: { sku: string }) {
  const [open, setOpen] = useState(false), [data, setData] = useState<PriceData | null>(null), [error, setError] = useState('');
  async function toggle() {
    const next = !open; setOpen(next);
    if (!next || data) return;
    setError('');
    try {
      const { data: sessionData } = await floorCloud().auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) throw new Error('Sign in to load marketplace prices.');
      const res = await fetch(`${base}/api/marketplace-prices?sku=${encodeURIComponent(sku)}`, { headers: { Authorization: `Bearer ${token}` } });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Price request failed (${res.status})`);
      setData(body);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  return <div className="border-b border-floor-line py-3">
    <button type="button" className="w-full text-left font-medium" onClick={() => void toggle()}>Marketplace prices <span className="float-right">{open ? '−' : '+'}</span></button>
    {open && <div className="mt-3 space-y-2 text-sm">
      {error && <p className="text-red-700">{error}</p>}
      {!data && !error && <p>Loading prices…</p>}
      {data && <>
        <p>Label estimate: {formatCents(data.label_estimate_cents)}</p>
        {data.missing_package_data && <p className="text-amber-800">Missing package dims — label cost is estimated.</p>}
        {channels.map(([key, label]) => <div className="flex justify-between" key={key}><span>{label}</span><strong>{formatCents(data.prices[key])}</strong></div>)}
      </>}
    </div>}
  </div>;
}
