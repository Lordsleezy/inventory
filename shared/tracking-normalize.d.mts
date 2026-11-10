export function compactTracking(value: string): string;
export function trackingSuffix(value: string): string;
export function scanContainsTracking(scanned: string, stored: string): boolean;
export function takeLabelScans(raw: string, held?: string): { scans: string[]; held: string };
