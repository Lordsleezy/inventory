"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { SkuKeypad } from "@/components/sku-keypad";

type Tile = { username: string; displayName: string; role: string };

export default function LoginPage() {
  const router = useRouter();
  const [staff, setStaff] = useState<Tile[]>([]);
  const [username, setUsername] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/auth/login")
      .then((res) => res.json())
      .then((data) => {
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
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, pin: code }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Wrong PIN");
      setPin("");
      return;
    }
    router.replace("/inventory");
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 bg-floor-bg p-4 text-floor-text">
      <h1 className="text-center text-4xl font-black text-floor-accent">FLOOR</h1>
      <div className="grid gap-2">
        {staff.map((row) => (
          <button
            key={row.username}
            type="button"
            onClick={() => {
              setUsername(row.username);
              setPin("");
              setError("");
            }}
            className={`min-h-14 rounded-xl border text-xl font-bold ${
              username === row.username
                ? "border-floor-accent bg-floor-accent text-black"
                : "border-floor-line bg-floor-panel"
            }`}
          >
            {row.displayName}
          </button>
        ))}
      </div>
      <SkuKeypad
        value={pin}
        onChange={setPin}
        maxLength={8}
        onEnter={() => void submit(pin)}
        onClear={() => setError("")}
      />
      {error ? <p className="text-center text-xl font-bold text-floor-danger">{error}</p> : null}
    </div>
  );
}
