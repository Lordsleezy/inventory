import { registerPlugin } from "@capacitor/core";

export type ChargeResult = {
  ok: boolean;
  paymentId?: string;
  cardBrand?: string;
  cardLast4?: string;
  reason?: string;
  message?: string;
  mock?: boolean;
  authState?: string;
};

export type AuthStateResult = {
  state: string;
  sdkInitialized: boolean;
  sdkLinked: boolean;
  squareApplicationIdSet?: boolean;
};

export interface FloorSquarePlugin {
  authorize(options: {
    accessToken: string;
    locationId: string;
    mock?: boolean;
  }): Promise<{ ok: boolean; reason?: string; message?: string; mock?: boolean; already?: boolean }>;
  charge(options: {
    amountCents: number;
    mock?: boolean;
    referenceId?: string;
  }): Promise<ChargeResult>;
  preparePermissions?(): Promise<{
    ok: boolean;
    reason?: string;
    message?: string;
    location?: boolean;
    bluetooth?: boolean;
  }>;
  authState?(): Promise<AuthStateResult>;
  startPairing?(): Promise<{ ok: boolean; mock?: boolean }>;
  openAuth(options: { url: string }): Promise<{ ok: boolean }>;
}

const FloorSquare = registerPlugin<FloorSquarePlugin>("FloorSquare", {
  web: {
    async authorize(options: { mock?: boolean }) {
      if (options.mock) return { ok: false, reason: "mock_authorize_disabled" };
      return { ok: false, reason: "not_native" };
    },
    async charge() {
      return { ok: false, reason: "not_native" };
    },
    async preparePermissions() {
      return { ok: true, location: true, bluetooth: true };
    },
    async authState() {
      return { state: "notLinked", sdkInitialized: false, sdkLinked: false };
    },
    async openAuth(options: { url: string }) {
      window.location.assign(options.url);
      return { ok: true };
    },
  },
});

export { FloorSquare };
