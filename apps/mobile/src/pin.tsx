import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { floorCloud } from "@floor/cloud";
import { Label, Notice } from "./components/ui";

type PinRequest = {
  action: string;
  sku: string;
  resolve: (id: string) => void;
  reject: (err: Error) => void;
};

const PinCtx = createContext<(action: string, sku: string) => Promise<string>>(async () => {
  throw new Error("PIN prompt is not ready");
});

export function useAskPin() {
  return useContext(PinCtx);
}

export function PinProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<PinRequest | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const ask = useCallback((action: string, sku: string) => {
    return new Promise<string>((resolve, reject) => {
      setPin("");
      setError("");
      setReq({ action, sku, resolve, reject });
    });
  }, []);

  useEffect(() => {
    setPinAsk(ask);
    return () => setPinAsk(null);
  }, [ask]);

  async function submit() {
    if (!req) return;
    setBusy(true);
    setError("");
    try {
      const { data, error: rpcErr } = await floorCloud().rpc("approve_with_pin", {
        p_action: req.action,
        p_sku: req.sku,
        p_pin: pin,
      });
      if (rpcErr) {
        if (/pin_locked/i.test(rpcErr.message)) throw new Error("PIN locked after 5 tries. Wait a few minutes.");
        if (/pin_wrong/i.test(rpcErr.message)) throw new Error("Wrong PIN.");
        if (/pin_not_set/i.test(rpcErr.message)) throw new Error("Set a manager PIN in Setup first.");
        throw new Error(rpcErr.message);
      }
      req.resolve(String(data));
      setReq(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    req?.reject(new Error("Manager PIN cancelled"));
    setReq(null);
  }

  return (
    <PinCtx.Provider value={ask}>
      {children}
      {req ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center">
          <div className="w-full max-w-md border border-floor-line bg-floor-bg p-4">
            <h2 className="text-title">Manager PIN</h2>
            <p className="mt-1 text-quiet text-floor-mute">
              Required to {req.action.replace(/_/g, " ")} SKU {req.sku}.
            </p>
            <Notice tone="error">{error}</Notice>
            <label className="block py-2">
              <Label>PIN</Label>
              <input
                className="field mt-1"
                type="password"
                inputMode="numeric"
                autoFocus
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submit();
                }}
              />
            </label>
            <div className="mt-3 flex gap-3">
              <button type="button" className="btn-accent" disabled={busy || !pin} onClick={() => void submit()}>
                {busy ? "Checking…" : "Approve"}
              </button>
              <button type="button" className="btn-text px-0" disabled={busy} onClick={cancel}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </PinCtx.Provider>
  );
}

let pinAskImpl: ((action: string, sku: string) => Promise<string>) | null = null;

export function setPinAsk(fn: ((action: string, sku: string) => Promise<string>) | null): void {
  pinAskImpl = fn;
}

export function askManagerPin(action: string, sku: string): Promise<string> {
  if (!pinAskImpl) return Promise.reject(new Error("Manager PIN prompt is not ready."));
  return pinAskImpl(action, sku);
}
