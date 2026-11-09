import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { errText } from './errText';

export function DnsCheckbox({
  client, sku, onChanged, pendingValue, onPendingChange, variant = 'checkbox',
}: {
  client: SupabaseClient;
  sku: string;
  onChanged: (dns: boolean) => void;
  pendingValue?: boolean;
  onPendingChange?: (dns: boolean) => void;
  /** `switch` = iOS-style toggle with full explanation (item edit). */
  variant?: 'checkbox' | 'switch' | 'row';
}) {
  const [value, setValue] = useState<{ dns: boolean; required: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    void Promise.resolve(client.rpc('portal_unit_dns', { p_sku: sku })).then(({ data, error: e }) => {
      if (!alive) return;
      if (e) setError(errText(e));
      else setValue(data);
    });
    return () => { alive = false; };
  }, [client, sku]);

  async function change(dns: boolean) {
    if (onPendingChange) { onPendingChange(dns); return; }
    setBusy(true); setError('');
    const { data, error: e } = await client.rpc('portal_set_unit_dns', { p_sku: sku, p_dns: dns });
    if (e) setError(errText(e));
    else { setValue(data); onChanged(data.dns); }
    setBusy(false);
  }

  const on = pendingValue ?? !!value?.dns;
  const disabled = busy || !value || value.required;
  const help = `Pickup only. Hides it from eBay, Amazon, TikTok, Depop and Mercari.${value?.required ? ' Required for this oversized item type.' : ''}`;

  if (variant === 'row') {
    return (
      <label className="unit-edit-flag">
        <input
          type="checkbox"
          checked={on}
          disabled={disabled}
          aria-label="Do not ship"
          onChange={(e) => void change(e.target.checked)}
        />
        Do not ship
        {error && <span className="error" role="alert">{error}</span>}
      </label>
    );
  }

  if (variant === 'switch') {
    return (
      <div className="dns-switch-row unit-edit-wide">
        <div className="dns-switch-copy">
          <strong>Do not ship (DNS)</strong>
          <p className="hint">{help}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="Do not ship"
          className={`ios-switch${on ? ' is-on' : ''}`}
          disabled={disabled}
          onClick={() => void change(!on)}
        >
          <span className="ios-switch-knob" />
        </button>
        {error && <p className="error" role="alert">{error}</p>}
      </div>
    );
  }

  return (
    <div className="unit-edit-wide">
      <label className="mboard-inline">
        <input
          type="checkbox"
          checked={on}
          disabled={disabled}
          onChange={(e) => void change(e.target.checked)}
        />{' '}
        DNS — Do not ship
      </label>
      <p className="hint">{help}</p>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
