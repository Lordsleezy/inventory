import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { apiJson, setToken } from "../api";

type Tile = { username: string; displayName: string; role: string };

export function LoginScreen() {
  const navigate = useNavigate();
  const [staff, setStaff] = useState<Tile[]>([]);
  const [username, setUsername] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void apiJson<{ staff?: Tile[] }>("/api/auth/login").then(({ data }) => {
      setStaff(data.staff ?? []);
      if (data.staff?.length === 1) setUsername(data.staff[0].username);
    });
  }, []);

  useEffect(() => {
    if (pin.length === 4 && username) void submit(pin);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin, username]);

  async function submit(code: string) {
    if (!username) {
      setError("Pick your name");
      return;
    }
    setError("");
    const { ok, data } = await apiJson<{ error?: string; token?: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, pin: code }),
    });
    if (!ok || !data.token) {
      setError(data.error ?? "Wrong PIN");
      setPin("");
      return;
    }
    setToken(data.token);
    navigate("/inventory", { replace: true });
  }

  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clr", "0", "go"];

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 bg-floor-bg px-4 text-floor-text">
      <h1 className="text-center text-quiet tracking-[0.18em] text-floor-mute">FLOOR</h1>
      <div className="grid gap-1">
        {staff.map((row) => (
          <button
            key={row.username}
            type="button"
            onClick={() => {
              setUsername(row.username);
              setPin("");
              setError("");
            }}
            className={`min-h-touch px-2 text-left text-title ${
              username === row.username ? "text-floor-accent" : "text-floor-text"
            }`}
          >
            {row.displayName}
          </button>
        ))}
      </div>
      <p className="text-center text-4xl font-black tracking-[0.4em] text-floor-accent">
        {pin.replace(/./g, "•") || " "}
      </p>
      <div className="grid grid-cols-3 gap-2">
        {keys.map((key) => (
          <button
            key={key}
            type="button"
            className="min-h-14 bg-floor-panel text-2xl text-floor-text"
            onClick={() => {
              if (key === "clr") {
                setPin("");
                setError("");
                return;
              }
              if (key === "go") {
                void submit(pin);
                return;
              }
              setPin((current) => (current.length >= 8 ? current : current + key));
            }}
          >
            {key === "clr" ? "clr" : key === "go" ? "go" : key}
          </button>
        ))}
      </div>
      {error ? <p className="text-center text-body text-floor-danger">{error}</p> : null}
      <Link to="/setup" className="btn-text justify-center px-0">
        Change API address
      </Link>
    </div>
  );
}
