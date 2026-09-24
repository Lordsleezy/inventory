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
  signup_code?: string | null;
  balance: number;
  credit_cents?: number;
};

export type CustomerListRow = {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  marketing_opt_in: boolean;
  unsubscribed: boolean;
  first_purchase_discount_used: boolean;
  signup_code: string | null;
  created_at: string;
  points: number;
  credit_cents: number;
  spend_cents: number;
  last_visit: string | null;
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

// Database ledger units are one tenth of a customer-facing point. Keeping the
// legacy ledger denomination preserves every member's existing dollar value.
const customerPoints = (value: unknown): number => (Number(value) || 0) / 10;

function customerView<T extends Customer | CustomerListRow>(row: T): T {
  if ("balance" in row) return { ...row, balance: customerPoints(row.balance) };
  return { ...row, points: customerPoints(row.points) };
}

export async function lookupCustomerByPhone(phone: string): Promise<Customer | null> {
  await assertOnline();
  const { data, error } = await floorCloud().rpc("lookup_customer_by_phone", {
    p_phone: phone,
  });
  if (error) throw mapSellError(error);
  return data ? customerView(data as Customer) : null;
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
  return customerView(data as Customer);
}

export async function customerPointsBalance(customerId: string): Promise<number> {
  await assertOnline();
  const { data, error } = await floorCloud().rpc("customer_points_balance", {
    p_customer_id: customerId,
  });
  if (error) throw mapSellError(error);
  return customerPoints(data);
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
  return ((data as PointsLedgerRow[]) ?? []).map((row) => ({
    ...row,
    delta: customerPoints(row.delta),
    balance_after: customerPoints(row.balance_after),
  }));
}

export async function listCustomers(q?: string | null, limit = 200): Promise<CustomerListRow[]> {
  await assertOnline();
  const { data, error } = await floorCloud().rpc("list_customers", {
    p_q: q || null,
    p_limit: limit,
  });
  if (error) throw mapSellError(error);
  return ((data as CustomerListRow[]) ?? []).map((row) => customerView(row));
}

export async function adjustCustomerPoints(args: {
  customerId: string;
  delta: number;
  note?: string | null;
}): Promise<Customer> {
  await assertOnline();
  const { data, error } = await floorCloud().rpc("adjust_customer_points", {
    p_customer_id: args.customerId,
    p_delta: Math.round(args.delta * 10),
    p_note: args.note ?? null,
  });
  if (error) throw mapSellError(error);
  return customerView(data as Customer);
}

export async function queueLoyaltyCampaign(args: {
  subject: string;
  body: string;
  minSpendCents?: number;
  days?: number | null;
}): Promise<{ campaign_id: string; queued: number }> {
  await assertOnline();
  const { data, error } = await floorCloud().rpc("queue_loyalty_campaign", {
    p_subject: args.subject,
    p_body: args.body,
    p_min_spend_cents: args.minSpendCents ?? 0,
    p_days: args.days ?? null,
  });
  if (error) throw mapSellError(error);
  return data as { campaign_id: string; queued: number };
}
