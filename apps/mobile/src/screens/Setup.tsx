import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { getApiUrl, pingApi, setApiUrl } from "../api";

export function SetupScreen() {
  const navigate = useNavigate();
  const [url, setUrl] = useState(getApiUrl() || "http://192.168.68.51:3000");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError("");
    try {
      const origin = await pingApi(url);
      setApiUrl(origin);
      navigate("/login", { replace: true });
    } catch {
      setError("Could not reach Floor on that address. Same Wi‑Fi or Tailscale, port 3000.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-5 bg-floor-bg px-4 text-floor-text">
      <h1 className="text-center text-quiet tracking-[0.18em] text-floor-mute">FLOOR</h1>
      <p className="text-body">This app is on the phone. Stock still lives on the tablet — enter that API address.</p>
      <label className="text-quiet text-floor-mute">
        Floor API
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="http://192.168.68.51:3000"
          className="field mt-1"
        />
      </label>
      {error ? <p className="text-body text-floor-danger">{error}</p> : null}
      <button type="button" disabled={busy || !url.trim()} onClick={() => void save()} className="btn-accent">
        {busy ? "Checking…" : "Continue"}
      </button>
    </div>
  );
}
