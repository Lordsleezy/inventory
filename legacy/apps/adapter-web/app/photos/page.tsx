"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Shell } from "@/components/shell";

type Unmatched = { name: string; path: string };

export default function PhotosPage() {
  const [unmatched, setUnmatched] = useState<Unmatched[]>([]);
  const [dropPath, setDropPath] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function load() {
    const res = await fetch("/api/photos");
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Could not load photos");
      return;
    }
    setUnmatched(data.unmatched ?? []);
    setDropPath(data.dropPath);
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <Shell>
      <h1 className="mb-3 text-2xl font-black">Unmatched photos</h1>
      <p className="text-floor-mute">
        Files that are not a 5-digit SKU stay here. Floor never deletes them.
      </p>
      {dropPath ? <p className="mt-2 text-sm text-floor-mute">{dropPath}</p> : <p className="mt-2">No drop folder configured.</p>}
      {error ? <p className="font-bold text-floor-danger">{error}</p> : null}
      <ul className="mt-4 grid gap-2">
        {unmatched.map((row) => (
          <li key={row.path} className="rounded-lg border border-floor-line bg-floor-panel p-3 font-mono text-sm">
            {row.name}
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => void load()} className="mt-3 min-h-touch rounded-lg border border-floor-line px-4 font-bold">
        Refresh
      </button>
      <Link href="/inventory" className="mt-3 flex min-h-touch items-center font-bold text-floor-accent">
        ← Inventory
      </Link>
    </Shell>
  );
}
