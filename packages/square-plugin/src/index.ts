import { registerPlugin } from "@capacitor/core";

export interface FloorSquarePlugin {
  authorize(options: { accessToken: string; locationId: string }): Promise<{ ok: boolean }>;
  charge(options: { amountCents: number }): Promise<{ ok: boolean; paymentId?: string; reason?: string }>;
  openAuth(options: { url: string }): Promise<{ ok: boolean }>;
}

const FloorSquare = registerPlugin<FloorSquarePlugin>("FloorSquare", {
  web: {
    async authorize() {
      return { ok: false };
    },
    async charge() {
      return { ok: false, reason: "not_linked" };
    },
    async openAuth(options) {
      window.location.assign(options.url);
      return { ok: true };
    },
  },
});

export { FloorSquare };
