/** Never infer a sale channel from where the unit used to be listed. */
export function channelSaleHistory(rows, channel) {
  return (rows || []).filter(row => String(row.channel || '').trim().toLowerCase() === channel);
}

export function activeChannelSales(rows, channel) {
  return channelSaleHistory(rows, channel).filter(row => row.voided_at == null);
}
