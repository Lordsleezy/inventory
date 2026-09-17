import { authErrorMessage } from "@floor/cloud";

export function rpcMessage(err: unknown): string {
  return authErrorMessage(err);
}

export function needsManagerPin(err: unknown): boolean {
  return /manager_approval_required/i.test(rpcMessage(err));
}

export function needsVoidFirst(err: unknown): boolean {
  return /void_the_sale_first/i.test(rpcMessage(err));
}

export function friendlyRpc(err: unknown): string {
  const msg = rpcMessage(err);
  if (!msg || msg === "[object Object]") return "Something went wrong";
  if (/manager_approval_required/i.test(msg)) return "A manager PIN is required.";
  if (/void_the_sale_first/i.test(msg)) return "This item has a sale. Void the sale first to delete it.";
  if (/sale_not_voidable/i.test(msg)) return "That sale cannot be voided.";
  if (/void_needs_reason/i.test(msg)) return "Enter a reason to void.";
  if (/pin_locked/i.test(msg)) return "PIN locked after 5 tries. Wait a few minutes.";
  if (/pin_wrong/i.test(msg)) return "Wrong PIN.";
  if (/pin_not_set/i.test(msg)) return "Set a manager PIN in Setup first.";
  return msg;
}
