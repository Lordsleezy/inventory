import { useReader } from "../reader-host";
import { useStore } from "../store";
import { Label, Notice } from "../components/ui";

/**
 * Pair-code / authorize controls. Heartbeat + pending charges run app-wide via ReaderProvider.
 */
export function PaymentDeviceScreen() {
  const { session } = useStore();
  const {
    pairCode,
    authorized,
    locationId,
    locationName,
    sandbox,
    authorizing,
    authDiag,
    pending,
    error,
    status,
    chargingId,
    authorizeSdk,
    takePayment,
    resetPairing,
  } = useReader();

  const storeLabel = session?.storeId ? session.storeId.slice(0, 8) : "—";
  const locationLabel = locationName
    ? `${locationName} (${locationId})`
    : locationId || "—";

  return (
    <div className="p-4 pb-28">
      <h1 className="text-title">Payment device</h1>
      <p className="text-quiet mt-1">
        This phone stays paired across restarts. Incoming charges also pop up on other screens. Store{" "}
        {storeLabel}…
      </p>
      <p className="text-quiet mt-2">
        Sandbox: after Authorize, tap the floating mock reader and add Contactless &amp; chip before Take payment.
        Physical Square readers do not work in sandbox.
      </p>
      <div className="mt-4 rounded-xl border border-floor-line bg-floor-panel px-4 py-5 text-center">
        <p className="text-quiet tracking-wide text-floor-mute">Pair code</p>
        <p className="mt-2 font-mono text-4xl font-bold tracking-[0.35em] text-floor-text">
          {pairCode || (error ? "———" : "······")}
        </p>
        {!pairCode && !error ? (
          <p className="text-quiet mt-2">Registering this phone as a reader…</p>
        ) : (
          <p className="text-quiet mt-2">Enter this code once on the register. It persists until you reset pairing.</p>
        )}
      </div>
      <div className="mt-4 rounded-xl border border-floor-line bg-floor-panel px-4 py-4">
        <p className="text-quiet tracking-wide text-floor-mute">Square</p>
        {authorized ? (
          <p className="text-body mt-1">
            Authorized{sandbox ? " (sandbox)" : ""} · {locationLabel}
          </p>
        ) : (
          <p className="text-body mt-1">Not authorized — register Card will refuse until this succeeds.</p>
        )}
      </div>
      {authDiag ? (
        <pre className="text-quiet mt-3 overflow-x-auto whitespace-pre-wrap rounded-lg border border-floor-line bg-floor-panel p-3 text-left text-xs leading-5">
          {authDiag}
        </pre>
      ) : null}
      {!session ? <Notice tone="error">Sign in required.</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {status ? <p className="text-quiet mt-2 whitespace-pre-wrap">{status}</p> : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-accent"
          disabled={authorizing || !session}
          onClick={() => {
            void authorizeSdk().catch(() => {
              /* authorizeSdk already setError */
            });
          }}
        >
          {authorizing ? "Authorizing…" : authorized ? "Re-authorize Square" : "Authorize Square"}
        </button>
        <button type="button" className="btn-text" onClick={() => void resetPairing()}>
          Reset pairing
        </button>
      </div>
      <div className="mt-6">
        <Label>Pending charges</Label>
      </div>
      {!pending.length ? <p className="text-quiet mt-2">None — waiting for the register.</p> : null}
      <ul className="mt-2 space-y-2">
        {pending.map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-2 border border-floor-line p-3">
            <div>
              <div className="text-body">{c.title || c.sku}</div>
              <div className="text-quiet text-sm">
                ${(c.amount_cents / 100).toFixed(2)} · tax ${(c.tax_cents / 100).toFixed(2)}
              </div>
            </div>
            <button
              type="button"
              className="btn-accent"
              disabled={chargingId === c.id}
              onClick={() => void takePayment(c)}
            >
              {chargingId === c.id ? "Charging…" : "Take payment"}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
