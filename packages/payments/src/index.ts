export type ChargeInput = {
  amountCents: number;
  currency: "USD";
};

export type ChargeResult =
  | { ok: true; paymentId: string }
  | { ok: false; reason: "declined" | "timeout" | "cancelled" | "not_linked" };

export interface PaymentProvider {
  id: string;
  charge(input: ChargeInput): Promise<ChargeResult>;
}

export const cashProvider: PaymentProvider = {
  id: "cash",
  async charge() {
    return { ok: true, paymentId: `cash_${Date.now()}` };
  },
};

export function stubCardProvider(outcome: "success" | "decline" | "timeout"): PaymentProvider {
  return {
    id: "card-stub",
    async charge() {
      if (outcome === "success") return { ok: true, paymentId: `stub_${Date.now()}` };
      if (outcome === "timeout") return { ok: false, reason: "timeout" };
      return { ok: false, reason: "declined" };
    },
  };
}

export const unlinkedCardProvider: PaymentProvider = {
  id: "card-unlinked",
  async charge() {
    return { ok: false, reason: "not_linked" };
  },
};
