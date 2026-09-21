import { registerPlugin } from "@capacitor/core";

export type ChargeResult = {
  ok: boolean;
  paymentId?: string;
  cardBrand?: string;
  cardLast4?: string;
  reason?: string;
  message?: string;
  code?: number;
  localizedDescription?: string;
  mock?: boolean;
  authState?: string;
};

export type AuthStateResult = {
  state: string;
  sdkInitialized: boolean;
  sdkLinked: boolean;
  squareApplicationIdSet?: boolean;
  squareApplicationId?: string;
  locationId?: string | null;
  sandbox?: boolean;
  mockReaderLinked?: boolean;
};

export type AuthorizeResult = {
  ok: boolean;
  reason?: string;
  message?: string;
  code?: number;
  localizedDescription?: string;
  mock?: boolean;
  already?: boolean;
  locationId?: string;
  squareApplicationId?: string;
  sandbox?: boolean;
  authState?: string;
};

export interface FloorSquarePlugin {
  authorize(options: {
    accessToken: string;
    locationId: string;
    mock?: boolean;
  }): Promise<AuthorizeResult>;
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
    locationFix?: boolean;
    bluetooth?: boolean;
    latitude?: number;
    longitude?: number;
    accuracyMeters?: number;
    deviceCountry?: string;
    localeRegion?: string;
  }>;
  authState?(): Promise<AuthStateResult & { sandbox?: boolean; squareApplicationId?: string }>;
  startPairing?(): Promise<{ ok: boolean; mock?: boolean; message?: string; reason?: string }>;
  presentMockReader?(): Promise<{
    ok: boolean;
    skipped?: boolean;
    mockReaderPresented?: boolean;
    message?: string;
    reason?: string;
    sandbox?: boolean;
  }>;
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
    async presentMockReader() {
      return { ok: false, reason: "not_native", message: "Mock Reader requires the native iOS build." };
    },
    async openAuth(options: { url: string }) {
      window.location.assign(options.url);
      return { ok: true };
    },
  },
});

export { FloorSquare };
