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
  if (/held_by_online_order/i.test(msg)) return "Someone is paying for this item online right now. Try again in a few minutes.";
  if (/pickup_not_open/i.test(msg)) return "That pickup was already handed over or canceled.";
  if (/unit_has_sales_history|void_the_sale_first/i.test(msg)) {
    return "This item has sales history. Mark it sold or given away instead of deleting it.";
  }
  if (/unit_in_bundle/i.test(msg)) return "This SKU is part of a bundle. Remove it from the bundle first.";
  if (/unit_listing_in_progress/i.test(msg)) {
    return "A listing is still being published for this item. Wait a minute and try again.";
  }
  if (/unit_still_listed:(\w+)/i.test(msg)) {
    const m = msg.match(/unit_still_listed:(\w+)/i);
    const ch = (m?.[1] || "online").toLowerCase();
    const label =
      ch === "ebay" ? "eBay"
      : ch === "depop" ? "Depop"
      : ch === "whatnot" ? "Whatnot"
      : ch === "mercari" ? "Mercari"
      : ch === "amazon" ? "Amazon"
      : ch === "tiktok" ? "TikTok Shop"
      : ch === "facebook" ? "Facebook"
      : ch === "website" ? "the website"
      : ch.charAt(0).toUpperCase() + ch.slice(1);
    return `This item is still listed on ${label}. End the listing first.`;
  }
  if (/violates foreign key|foreign key/i.test(msg)) {
    return "Couldn't delete this item because something is still linked to it. Refresh and try again.";
  }
  if (/sale_not_voidable/i.test(msg)) return "That sale cannot be voided.";
  if (/void_needs_reason/i.test(msg)) return "Enter a reason to void.";
  if (/pin_locked/i.test(msg)) return "PIN locked after 5 tries. Wait a few minutes.";
  if (/pin_wrong/i.test(msg)) return "Wrong PIN.";
  if (/pin_not_set/i.test(msg)) return "Set a manager PIN in Setup first.";
  if (/use_category_rpc/i.test(msg)) return "Change categories in Setup → Categories.";
  if (/use_pin_rpc/i.test(msg)) return "Change the PIN with Save PIN.";
  if (/^invalid$/i.test(msg) || msg === "ebay_list_failed") {
    return "eBay rejected the listing. The next attempt will show eBay’s actual reason.";
  }
  return msg;
}
