/** Normalize only completed, positive deposits; failed/negative payout records are not bank deposits. */
export function normalizeBooksPayout(platform, payout) {
  const source = String(platform || '').toLowerCase();
  if (!['ebay', 'square', 'tiktok'].includes(source) || !payout || typeof payout !== 'object') return null;
  const id = String(source === 'ebay' ? payout.payoutId || payout.payout_id || '' : payout.id || '').trim();
  const status = String(source === 'ebay' ? payout.payoutStatus || payout.status || '' : payout.status || '').toUpperCase();
  const validStatuses = source === 'ebay' ? ['SUCCEEDED'] : source === 'square' ? ['PAID', 'SENT'] : ['PAID'];
  const rawAmount = source === 'ebay' ? payout.amount : source === 'square' ? payout.amount_money : payout.amount;
  const amount = Number(rawAmount && typeof rawAmount === 'object' ? rawAmount.value ?? rawAmount.amount : rawAmount);
  if (source === 'tiktok' && String(rawAmount?.currency || '').toUpperCase() !== 'USD') return null;
  const cents = source === 'square' ? Math.trunc(amount) : Math.round(amount * 100);
  const when = source === 'ebay' ? payout.payoutDate || payout.payout_date : source === 'square' ? payout.arrival_date || payout.updated_at || payout.created_at : payout.paid_time;
  const date = typeof when === 'string' ? when.slice(0, 10) : Number.isFinite(Number(when)) && Number(when) > 0
    ? new Date(Number(when) * 1000).toISOString().slice(0, 10) : '';
  if (!id || !validStatuses.includes(status) || !Number.isSafeInteger(cents) || cents <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return {
    platform: source,
    external_payout_id: id,
    amount_cents: cents,
    withdrawn_on: date,
    bank_reference: String(source === 'ebay' ? payout.bankReference || payout.bank_reference || '' : source === 'square' ? payout.end_to_end_id || '' : '').trim() || null,
    note: `Imported from ${source === 'ebay' ? 'eBay Finances' : source === 'square' ? 'Square' : 'TikTok Shop Finance'} API`,
  };
}

export async function saveBooksPayout(sb, storeId, payout) {
  if (!payout || !storeId) return { skipped: true };
  const { data: locked, error: periodError } = await sb.from('books_periods').select('id')
    .eq('store_id', storeId).eq('period_type', 'month').eq('status', 'locked')
    .lte('period_start', payout.withdrawn_on).gte('period_end', payout.withdrawn_on).maybeSingle();
  if (periodError) throw new Error(periodError.message);
  if (locked) return { skipped: true, reason: 'books_period_locked', platform: payout.platform, payoutId: payout.external_payout_id };
  const { error } = await sb.from('platform_withdrawals').upsert(
    { store_id: storeId, ...payout, created_by: null },
    { onConflict: 'store_id,platform,external_payout_id' },
  );
  if (error) throw new Error(error.message);
  return { imported: true, platform: payout.platform, payoutId: payout.external_payout_id };
}
