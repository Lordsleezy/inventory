export function stockMetadataPath(id: number) {
  return `/api/metadata/stockitem/pk/${id}/`;
}

export function partMetadataPath(id: number) {
  return `/api/metadata/part/pk/${id}/`;
}

export function salesOrderMetadataPath(id: number) {
  return `/api/metadata/salesorder/pk/${id}/`;
}
