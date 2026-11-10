import { useEffect, useState } from 'react';

type Row = {
  listing_id: string;
  sku: string;
  title: string;
  price: string;
  ebay_ship_cents: number | null;
  should_cents: number | null;
  difference_cents: number | string;
  class: string;
  reason: string;
  ebay_lb: number | string;
  floor_lb: number | string;
  ebay_dims: string;
  floor_dims: string;
};

function dollars(cents: number | null) {
  if (!(Number(cents) > 0)) return '—';
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

export function ShippingReview() {
  const [rows, setRows] = useState<Row[]>([]);
  const [filter, setFilter] = useState('all');
  const [note, setNote] = useState('Loading the shipping review.');

  useEffect(() => {
    void fetch('/shipping-review.json')
      .then((res) => res.json())
      .then((data: Row[]) => {
        setRows(data);
        setNote(`${data.length} active listings. Read only.`);
      })
      .catch(() => setNote('The review file did not load.'));
  }, []);

  const shown = rows.filter((row) => filter === 'all' || row.class === filter);
  return (
    <section style={{ background: '#000', color: '#fff', padding: '8px 16px 24px' }}>
      <h2 style={{ fontSize: 18, fontWeight: 600 }}>Shipping review</h2>
      <p style={{ color: '#9a9a9a' }}>{note} Compared with received package size at zone 6. A matching package was left as it is.</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '12px 0' }}>
        {['all', 'fine', 'too_high', 'too_low', 'unknown'].map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setFilter(name)}
            style={{
              background: filter === name ? '#fff' : 'transparent',
              color: filter === name ? '#000' : '#fff',
              border: '1px solid #4a4a4a',
              padding: '8px 12px',
            }}
          >
            {name === 'all' ? 'All' : name.replace('_', ' ')}
          </button>
        ))}
      </div>
      {shown.slice(0, 80).map((row) => (
        <div key={row.listing_id} style={{ borderTop: '1px solid #2a2a2a', padding: '12px 0' }}>
          <div>{row.title || row.sku}</div>
          <div style={{ color: '#9a9a9a', marginTop: 4 }}>{row.listing_id} · SKU {row.sku} · {row.price ? `$${row.price}` : 'no price'}</div>
          <div style={{ color: row.class === 'too_high' || row.class === 'too_low' ? '#FF453A' : '#9a9a9a', marginTop: 4 }}>
            {row.class} · eBay {dollars(row.ebay_ship_cents)} · should {dollars(row.should_cents)} · {row.reason}
          </div>
          <div style={{ color: '#9a9a9a', marginTop: 4 }}>eBay {row.ebay_lb} lb {row.ebay_dims} · received {row.floor_lb} lb {row.floor_dims}</div>
        </div>
      ))}
    </section>
  );
}
