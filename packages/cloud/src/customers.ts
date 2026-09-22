import { floorCloud } from "./client.ts";
import { assertOnline } from "./online.ts";
import { mapSellError } from "./sell.ts";

export type Customer = {
  id: string;
  store_id: string;
  phone: string;
  name: string | null;
  email: string | null;
  marketing_opt_in: boolean;
  first_purchase_discount_used: boolean;
  created_at: string;
  balance: number;
};

export type PointsLedgerRow = {
  id: number;
  delta: number;
  balance_after: number;
  reason: string;
  ticket_id: string | null;
  sale_id: number | null;
  actor_id: string | null;
  created_at: string;
};

export async function lookupCustomerByPhone(phone: string): Promise<Customer | null> {
  await assertOnline();
  const { data, error } = await floorCloud().rpc("lookup_customer_by_phone", {
    p_phone: phone,
  });
  if (error) throw mapSellError(error);
  return (data as Customer | null) ?? null;
}

export async function upsertCustomer(args: {
  phone: string;
  name?: string | null;
  email?: string | null;
  marketingOptIn?: boolean;
}): Promise<Customer> {
  await assertOnline();
  const { data, error } = await floorCloud().rpc("upsert_customer", {
    p_phone: args.phone,
    p_name: args.name ?? null,
    p_email: args.email ?? null,
    p_marketing_opt_in: args.marketingOptIn ?? false,
  });
  if (error) throw mapSellError(error);
  return data as Customer;
}

export async function customerPointsBalance(customerId: string): Promise<number> {
  await assertOnline();
  const { data, error } = await floorCloud().rpc("customer_points_balance", {
    p_customer_id: customerId,
  });
  if (error) throw mapSellError(error);
  return Number(data ?? 0);
}

export async function customerPointsHistory(
  customerId: string,
  limit = 50,
): Promise<PointsLedgerRow[]> {
  await assertOnline();
  const { data, error } = await floorCloud().rpc("customer_points_history", {
    p_customer_id: customerId,
    p_limit: limit,
  });
  if (error) throw mapSellError(error);
  return (data as PointsLedgerRow[]) ?? [];
}
