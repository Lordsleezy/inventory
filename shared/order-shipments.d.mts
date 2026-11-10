export function dedupeOrders(orders: any[]): any[];
export function shipmentLead(items: any[]): any;
export function sameBuyerAndAddress(a: any, b: any): { ok: boolean; reason?: string; message?: string };
export function canManualBundle(orders: any[]): {
  ok: boolean;
  reason?: string;
  message?: string | null;
  lead?: any;
  items?: any[];
  clearsLabels?: boolean;
};
export function canUnbundle(items: any[]): { ok: boolean; reason?: string; message?: string };
export function withPackageDims(order: any): any;
export function listShipments(orders: any[], opts?: any): any[];
export function countShipments(orders: any[], opts?: any): number;
export function suggestBundleGroups(orders: any[], opts?: any): any[];
export function shipmentPeers(shipment: any): any[];
export function shipmentHasLabel(shipment: any): boolean;
