export type LabelUploadResponse = {
  mismatch?: boolean;
  exception?: string;
  needs_tracking?: boolean;
  needs_picker?: boolean;
  tracking_number?: string | null;
  carrier?: string | null;
  layer?: string | null;
  tracking_candidates?: { number: string; carrier?: string | null; source?: string | null }[];
};

export type LabelUploadUi =
  | { kind: 'error'; message: string }
  | { kind: 'mismatch'; message: string }
  | { kind: 'picker'; candidates: NonNullable<LabelUploadResponse['tracking_candidates']> }
  | { kind: 'hit'; number: string; carrier?: string | null; layer?: string | null }
  | { kind: 'manual'; message: string }
  | { kind: 'ok' };

export function labelUploadUi(data: LabelUploadResponse): LabelUploadUi {
  if (data.mismatch) {
    return { kind: 'mismatch', message: "The label we read doesn't match eBay's tracking number." };
  }
  if (data.tracking_number) {
    return { kind: 'hit', number: data.tracking_number, carrier: data.carrier, layer: data.layer };
  }
  if (data.needs_picker && data.tracking_candidates?.length) {
    return { kind: 'picker', candidates: data.tracking_candidates };
  }
  if (data.needs_tracking) {
    return { kind: 'manual', message: "Couldn't read tracking from this label. Enter it on the order page." };
  }
  return { kind: 'ok' };
}
