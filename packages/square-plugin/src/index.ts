import { registerPlugin } from "@capacitor/core";

export type ChargeResult = {
  ok: boolean;
  paymentId?: string;
  cardBrand?: string;
  cardLast4?: string;
  reason?: string;
  mock?: boolean;
};

export interface FloorSquarePlugin {
  authorize(options: {
    accessToken: string;
    locationId: string;
    mock?: boolean;
  }): Promise<{ ok: boolean; reason?: string; mock?: boolean }>;
  charge(options: { amountCents: number; mock?: boolean }): Promise<ChargeResult>;
  startPairing?(): Promise<{ ok: boolean; mock?: boolean }>;
  openAuth(options: { url: string }): Promise<{ ok: boolean }>;
}

const FloorSquare = registerPlugin<FloorSquarePlugin>("FloorSquare", {
  web: {
    async authorize(options) {
      if (options.mock) return { ok: true, mock: true };
      return { ok: false, reason: "not_native" };
    },
    async charge(options) {
      if (options.mock) {
        return {
          ok: true,
          paymentId: `web_mock_${options.amountCents}_${Date.now()}`,
          cardBrand: "VISA",
          cardLast4: "1111",
          mock: true,
        };
      }
      return { ok: false, reason: "not_linked" };
    },
    async openAuth(options) {
      window.location.assign(options.url);
      return { ok: true };
    },
  },
});

export { FloorSquare };
