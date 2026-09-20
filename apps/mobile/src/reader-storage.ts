import { Preferences } from "@capacitor/preferences";

const DEVICE_ID_KEY = "floor.reader.deviceId";
const PAIR_CODE_KEY = "floor.reader.pairCode";
const PENDING_CAPTURE_KEY = "floor.reader.pendingCapture";

export type PendingCapture = {
  chargeId: string;
  paymentId: string;
  cardBrand?: string | null;
  cardLast4?: string | null;
  savedAt: string;
};

export async function loadReaderIdentity(): Promise<{ deviceId: string; pairCode: string } | null> {
  const [{ value: deviceId }, { value: pairCode }] = await Promise.all([
    Preferences.get({ key: DEVICE_ID_KEY }),
    Preferences.get({ key: PAIR_CODE_KEY }),
  ]);
  if (!deviceId || !pairCode) return null;
  return { deviceId, pairCode };
}

export async function saveReaderIdentity(deviceId: string, pairCode: string): Promise<void> {
  await Preferences.set({ key: DEVICE_ID_KEY, value: deviceId });
  await Preferences.set({ key: PAIR_CODE_KEY, value: pairCode });
}

export async function clearReaderIdentity(): Promise<void> {
  await Preferences.remove({ key: DEVICE_ID_KEY });
  await Preferences.remove({ key: PAIR_CODE_KEY });
}

export async function loadPendingCapture(): Promise<PendingCapture | null> {
  const { value } = await Preferences.get({ key: PENDING_CAPTURE_KEY });
  if (!value) return null;
  try {
    return JSON.parse(value) as PendingCapture;
  } catch {
    return null;
  }
}

export async function savePendingCapture(row: PendingCapture): Promise<void> {
  await Preferences.set({ key: PENDING_CAPTURE_KEY, value: JSON.stringify(row) });
}

export async function clearPendingCapture(): Promise<void> {
  await Preferences.remove({ key: PENDING_CAPTURE_KEY });
}
