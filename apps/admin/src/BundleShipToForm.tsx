import { useState } from 'react';

export type ShipToDraft = {
  buyer_name: string;
  ship_line1: string;
  ship_line2: string;
  ship_city: string;
  ship_region: string;
  ship_postal: string;
};

export function emptyShipTo(buyer = ''): ShipToDraft {
  return {
    buyer_name: buyer && !/^depop buyer$/i.test(buyer) ? buyer : '',
    ship_line1: '',
    ship_line2: '',
    ship_city: '',
    ship_region: '',
    ship_postal: '',
  };
}

export function shipToReady(draft: ShipToDraft) {
  return Boolean(
    draft.ship_line1.trim()
    && draft.ship_city.trim()
    && draft.ship_region.trim()
    && draft.ship_postal.trim(),
  );
}

type Props = {
  draft: ShipToDraft;
  onChange: (next: ShipToDraft) => void;
  hint?: string | null;
};

/** Compact ship-to fields for the Bundle bar when address is missing. */
export function BundleShipToForm({ draft, onChange, hint }: Props) {
  const set = (key: keyof ShipToDraft, value: string) => onChange({ ...draft, [key]: value });
  return (
    <div className="orders-bundle-ship-to">
      {hint ? <p className="orders-bundle-hint">{hint}</p> : null}
      <label>
        <span className="eyebrow">Buyer name</span>
        <input
          value={draft.buyer_name}
          onChange={(e) => set('buyer_name', e.target.value)}
          placeholder="Buyer name"
          autoComplete="name"
        />
      </label>
      <label>
        <span className="eyebrow">Street</span>
        <input
          value={draft.ship_line1}
          onChange={(e) => set('ship_line1', e.target.value)}
          placeholder="Street address"
          autoComplete="shipping address-line1"
        />
      </label>
      <label>
        <span className="eyebrow">Apt / suite</span>
        <input
          value={draft.ship_line2}
          onChange={(e) => set('ship_line2', e.target.value)}
          placeholder="Optional"
          autoComplete="shipping address-line2"
        />
      </label>
      <div className="orders-bundle-ship-to-row">
        <label>
          <span className="eyebrow">City</span>
          <input
            value={draft.ship_city}
            onChange={(e) => set('ship_city', e.target.value)}
            placeholder="City"
            autoComplete="shipping address-level2"
          />
        </label>
        <label>
          <span className="eyebrow">State</span>
          <input
            value={draft.ship_region}
            onChange={(e) => set('ship_region', e.target.value)}
            placeholder="CA"
            autoComplete="shipping address-level1"
          />
        </label>
        <label>
          <span className="eyebrow">ZIP</span>
          <input
            value={draft.ship_postal}
            onChange={(e) => set('ship_postal', e.target.value)}
            placeholder="ZIP"
            autoComplete="shipping postal-code"
          />
        </label>
      </div>
    </div>
  );
}

export function useShipToDraft(buyer = '') {
  return useState<ShipToDraft>(() => emptyShipTo(buyer));
}
