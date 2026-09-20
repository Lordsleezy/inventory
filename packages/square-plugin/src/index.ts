import { registerPlugin } from "@capacitor/core";

export interface FloorSquarePlugin {
  authorize(options: { accessToken: string; locationId: string; mock?: boolean }): Promise<{ ok: boolean; reason?: string }>;
  charge(options: { amountCents: number }): Promise<{ ok: boolean; paymentId?: string; reason?: string }>;
  startPairing?(): Promise<{ ok: boolean; mock?: boolean }>;
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
