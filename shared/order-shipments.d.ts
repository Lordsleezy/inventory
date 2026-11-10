export function shipmentLead(items: any[]): any;
export function sameBuyerAndAddress(a: any, b: any): { ok: boolean; reason?: string; message?: string };
export function canManualBundle(orders: any[]): { ok: boolean; reason?: string; message?: string; lead?: any; items?: any[] };
export function canUnbundle(items: any[]): { ok: boolean; reason?: string; message?: string };
export function withPackageDims(order: any): any;
export function listShipments(orders: any[], opts?: any): Array<{
  id: string;
  bundled: boolean;
  itemCount: number;
  items: any[];
  lead: any;
  quote?: any;
  package?: { length_in?: number; width_in?: number; height_in?: number; weight_lb?: number } | null;
}>;
export function countShipments(orders: any[], opts?: any): number;
export function shipmentPeers(shipment: any): any[];
export function shipmentHasLabel(shipment: any): boolean;
