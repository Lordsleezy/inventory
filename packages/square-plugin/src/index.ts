import { registerPlugin } from "@capacitor/core";

export interface FloorSquarePlugin {
  authorize(options: { accessToken: string; locationId: string }): Promise<{ ok: boolean }>;
  charge(options: { amountCents: number }): Promise<{ ok: boolean; paymentId?: string; reason?: string }>;
}

const FloorSquare = registerPlugin<FloorSquarePlugin>("FloorSquare", {
  web: {
    async authorize() {
      return { ok: false };
    },
    async charge() {
      return { ok: false, reason: "not_linked" };
    },
  },
});

export { FloorSquare };
