type ReceiveIdentity = { brand?: string | null; title?: string | null; model?: string | null;
  variant?: string | null; size?: string | null; unit_count?: number; aspects?: Record<string, string> | null };
export function receiveSpecifics(identity?: ReceiveIdentity): string;
export function receiveVariant(identity?: ReceiveIdentity): string;
