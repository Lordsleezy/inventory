import type { ReactNode } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { DepopSalePanel } from './DepopSalePanel';
import { ListingManagerPanel, type ListingChannel } from './ListingManagerPanel';
import { MarketplaceBoard, type BoardChannel } from './MarketplaceBoard';

const TITLES: Record<ListingChannel, { eyebrow: string; title: string; blurb: string }> = {
  ebay: {
    eyebrow: 'EBAY',
    title: 'eBay listings',
    blurb: 'List, edit, end, and migrate Inventory API listings on the selling account. Admin-only. Real photos only.',
  },
  amazon: {
    eyebrow: 'AMAZON',
    title: 'Amazon listings',
    blurb: 'Live SP-API offers plus the create / queue workflow. Admin-only. Real photos only — never Generic for branded items.',
  },
  tiktok: {
    eyebrow: 'TIKTOK SHOP',
    title: 'TikTok Shop listings',
    blurb: 'Product create / edit / end via Partner API once keys are connected. Admin-only.',
  },
  depop: {
    eyebrow: 'DEPOP',
    title: 'Depop listings',
    blurb: 'Type in each Depop sale by hand: item, sale price, Depop fee, payout, date. Nothing is imported from email. Admin-only.',
  },
};

type Props = {
  channel: ListingChannel;
  accessToken: string;
  money: (n: number) => string;
  /** Optional Amazon queue / create panel rendered under the listing manager. */
  amazonQueue?: ReactNode;
  /** Needed for the Depop sale form. */
  client?: SupabaseClient;
};

export function ChannelListingPage({ channel, accessToken, money, amazonQueue, client }: Props) {
  if (channel !== 'depop') {
    return (
      <>
        <MarketplaceBoard channel={channel as BoardChannel} accessToken={accessToken} money={money} />
        {channel === 'amazon' && amazonQueue ? (
          <details className="mboard-more">
            <summary>Amazon create queue and catalog tools</summary>
            {amazonQueue}
          </details>
        ) : null}
      </>
    );
  }
  const meta = TITLES[channel];
  return (
    <>
      <header>
        <div>
          <div className="eyebrow">{meta.eyebrow}</div>
          <h1>{meta.title}</h1>
          <p>{meta.blurb}</p>
        </div>
      </header>
      {client && <DepopSalePanel client={client} money={money} variant="desktop" />}
      <details className="mboard-more">
        <summary>Depop listings (mark a unit as listed on Depop)</summary>
        <p className="hint">No listing API. Push pack, post on Depop, paste the link. A unit counts as on Depop only with a listing row.</p>
        <ListingManagerPanel accessToken={accessToken} money={money} channel={channel} channelLocked />
      </details>
    </>
  );
}
