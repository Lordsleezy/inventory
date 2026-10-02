import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

type Review = {
  id: string; sku: string; unit_name: string; own_photo_path: string;
  candidate_paths: string[]; source_url: string; source_title: string;
  description: string; specs: Record<string, unknown>;
  confidence: number; visual_score: number; text_score: number;
  reason: string; created_at: string;
};
const pageSize = 12;
const functionsBase = (import.meta.env.VITE_FLOOR_FUNCTIONS_URL || 'https://inventoryobi.netlify.app').replace(/\/$/, '');

export function ReviewMatchesPage({ client, accessToken }: { client: SupabaseClient; accessToken: string }) {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [page, setPage] = useState(0);
  const [photos, setPhotos] = useState<Record<string,string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    void (async () => {
      const { data, error: e } = await client.rpc('portal_review_matches');
      if (!active) return;
      if (e) setError(e.message);
      else { setReviews((data || []) as Review[]); setError(''); }
    })();
    return () => { active = false; };
  }, [client, reload]);

  const visible = reviews.slice(page * pageSize, (page + 1) * pageSize);
  useEffect(() => {
    let active = true;
    void (async () => {
      const own = [...new Set(visible.map(x => x.own_photo_path).filter(Boolean))];
      const candidate = [...new Set(visible.flatMap(x => x.candidate_paths || []))];
      const [a, b] = await Promise.all([
        own.length ? client.storage.from('unit-photos').createSignedUrls(own, 3600) : Promise.resolve({ data: [], error: null }),
        candidate.length ? client.storage.from('photo-match-candidates').createSignedUrls(candidate, 3600) : Promise.resolve({ data: [], error: null })
      ]);
      if (!active) return;
      if (a.error || b.error) { setError(a.error?.message || b.error?.message || 'Photos unavailable'); return; }
      const next: Record<string,string> = {};
      (a.data || []).forEach((x, i) => { next[own[i]] = x.signedUrl || ''; });
      (b.data || []).forEach((x, i) => { next[candidate[i]] = x.signedUrl || ''; });
      setPhotos(next);
    })();
    return () => { active = false; };
  }, [client, page, reviews]);

  async function decide(id: string, action: 'approve' | 'reject') {
    setBusy(id); setError('');
    try {
      const response = await fetch(`${functionsBase}/.netlify/functions/portal-match-action`, {
        method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ id, action })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Review action failed');
      setReviews(current => current.filter(x => x.id !== id));
      setReload(n => n + 1);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  return <>
    <header><div><div className="eyebrow">PRODUCT MATCHING</div><h1>Review matches</h1>
      <p>Compare your unit with a possible product match. Approval publishes its photos and description.</p></div></header>
    {error && <div className="alert" role="alert">{error}</div>}
    <section className="panel">
      <h2>{new Set(reviews.map(review => review.sku)).size} units · {reviews.length} candidates waiting for review</h2>
      {!reviews.length && <div className="empty">No matches need a decision right now.</div>}
      <div className="match-review-list">{visible.map(review => <article className="match-review" key={review.id}>
        <div className="match-review-head"><div><strong>SKU {review.sku}</strong><p>{review.unit_name}</p></div>
          <span>{Math.round(Number(review.confidence) * 100)}% match score</span></div>
        <div className="match-comparison">
          <div><h3>Our unit</h3>{photos[review.own_photo_path] ? <img src={photos[review.own_photo_path]} alt={`Floor unit ${review.sku}`} loading="lazy" /> : <p>Photo unavailable</p>}</div>
          <div><h3>Possible product</h3><div className="match-candidates">{(review.candidate_paths || []).map(path => photos[path] ? <img key={path} src={photos[path]} alt={review.source_title} loading="lazy" /> : null)}</div></div>
        </div>
        <p className="match-source"><a href={review.source_url} target="_blank" rel="noreferrer">{review.source_title || 'View product source'}</a></p>
        <p className="match-reason">{review.reason}</p>
        {review.description && <div className="match-draft"><h3>Draft description</h3><p>{review.description}</p>
          {Object.keys(review.specs || {}).length > 0 && <pre>{JSON.stringify(review.specs, null, 2)}</pre>}</div>}
        <div className="actions"><button disabled={busy !== null} onClick={() => void decide(review.id, 'approve')}>Approve</button>
          <button className="secondary" disabled={busy !== null} onClick={() => void decide(review.id, 'reject')}>Reject</button></div>
      </article>)}</div>
      {reviews.length > pageSize && <div className="inventory-pagination"><button className="secondary" disabled={page === 0} onClick={() => setPage(n => n - 1)}>Previous</button>
        <span>{page * pageSize + 1}–{Math.min((page + 1) * pageSize, reviews.length)} of {reviews.length}</span>
        <button className="secondary" disabled={(page + 1) * pageSize >= reviews.length} onClick={() => setPage(n => n + 1)}>Next</button></div>}
    </section>
  </>;
}
