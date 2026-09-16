"use client";

import { useEffect, useRef, useState } from "react";
import { displayAskCents, formatUsd, hasPhotos, type FloorConfig, type ListingState, type Unit } from "@floor/domain";
import { Shell } from "@/components/shell";
import { SkuKeypad } from "@/components/sku-keypad";
import { UnitPreview } from "@/components/unit-preview";
import { EmptyValue } from "@/components/empty-value";

declare global {
  interface Window {
    floorDesktop?: {
      marketplaceOpen: (channel: string) => Promise<{ channel: string | null; url: string; signedIn: boolean; unrestricted: boolean; error?: string }>;
      marketplaceNavigate: (url: string) => Promise<{ url: string; error?: string; unrestricted: boolean }>;
      marketplaceBack: () => Promise<unknown>;
      marketplaceBounds: (bounds: { x: number; y: number; width: number; height: number }) => Promise<unknown>;
      marketplaceHide: () => Promise<unknown>;
      marketplaceStatus: () => Promise<{ unrestricted: boolean; signedIn: boolean; url: string; channel: string | null }>;
      onMarketplaceUrl: (cb: (url: string) => void) => void;
    };
  }
}

function listingText(unit: Unit) {
  return [
    [unit.brand, unit.model].filter(Boolean).join(" "),
    unit.title,
    unit.condition ? `Condition: ${unit.condition}` : "",
    `SKU ${unit.sku}`,
    formatUsd(displayAskCents(unit)),
  ]
    .filter(Boolean)
    .join("\n");
}

export default function ListOnlinePage() {
  const hole = useRef<HTMLDivElement>(null);
  const [config, setConfig] = useState<FloorConfig | null>(null);
  const [channel, setChannel] = useState("ebay");
  const [sku, setSku] = useState("");
  const [unit, setUnit] = useState<Unit | null>(null);
  const [missing, setMissing] = useState(false);
  const [url, setUrl] = useState("");
  const [signedIn, setSignedIn] = useState(false);
  const [desktop, setDesktop] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");

  const unrestricted = config?.marketplace.unrestricted ?? true;

  useEffect(() => {
    fetch("/api/config")
      .then((res) => res.json())
      .then((data) => setConfig(data.config));
    setDesktop(Boolean(window.floorDesktop));
    window.floorDesktop?.onMarketplaceUrl((next) => setUrl(next));
    return () => {
      void window.floorDesktop?.marketplaceHide();
    };
  }, []);

  useEffect(() => {
    if (!desktop || !window.floorDesktop) return;
    void window.floorDesktop.marketplaceOpen(channel).then((status) => {
      setUrl(status.url);
      setSignedIn(status.signedIn);
    });
  }, [channel, desktop]);

  useEffect(() => {
    if (!desktop) return;
    function send() {
      const box = hole.current?.getBoundingClientRect();
      if (!box) return;
      void window.floorDesktop?.marketplaceBounds({
        x: box.left,
        y: box.top,
        width: box.width,
        height: box.height,
      });
    }
    send();
    window.addEventListener("resize", send);
    const timer = setInterval(send, 500);
    return () => {
      window.removeEventListener("resize", send);
      clearInterval(timer);
    };
  }, [desktop]);

  useEffect(() => {
    if (sku.length !== 5) {
      setUnit(null);
      setMissing(false);
      return;
    }
    fetch(`/api/units/${sku}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) {
          setUnit(null);
          setMissing(true);
          return;
        }
        setMissing(false);
        setUnit(data.unit);
      })
      .catch(() => setMissing(true));
  }, [sku]);

  async function copyListing() {
    if (!unit) return;
    await navigator.clipboard.writeText(listingText(unit));
    setCopied("Copied listing text");
  }

  async function mark(state: ListingState) {
    if (!unit) return;
    setError("");
    const res = await fetch(`/api/units/${unit.sku}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "listing", channel, state, url: url || null }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Could not update listing");
      return;
    }
    setUnit(data.unit);
  }

  async function go() {
    const status = await window.floorDesktop?.marketplaceNavigate(url);
    if (status?.error) setError(status.error);
    else if (status?.url) setUrl(status.url);
  }

  const channels = config?.channels ?? [];
  const listing = unit?.listings.find((row) => row.channel === channel);

  return (
    <Shell>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-black">List online</h1>
        {unrestricted ? (
          <span className="rounded border border-floor-accent px-2 py-1 text-xs font-black uppercase tracking-wide text-floor-accent">
            Allowlist off
          </span>
        ) : (
          <span className="rounded border border-floor-line px-2 py-1 text-xs font-bold uppercase tracking-wide text-floor-mute">
            Allowlist on
          </span>
        )}
        {desktop ? (
          <span className={`text-sm font-bold ${signedIn ? "text-floor-ok" : "text-floor-danger"}`}>
            {signedIn ? "SIGNED IN" : "NEEDS RE-LOGIN"}
          </span>
        ) : (
          <span className="text-sm text-floor-mute">Marketplace browser runs in the Floor desktop app</span>
        )}
      </div>
      <div className="mb-2 flex flex-wrap gap-2">
        {channels.map((row) => (
          <button
            key={row.id}
            type="button"
            onClick={() => setChannel(row.id)}
            className={`min-h-touch rounded-lg px-3 font-black uppercase ${
              channel === row.id ? "bg-floor-accent text-black" : "border border-floor-line"
            } ${row.enabled ? "" : "opacity-60"}`}
          >
            {row.label}
            {row.enabled ? "" : " (off)"}
          </button>
        ))}
      </div>
      {desktop && unrestricted ? (
        <form
          className="mb-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void go();
          }}
        >
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="min-h-touch flex-1 rounded-lg border border-floor-line bg-black px-3"
            aria-label="URL"
          />
          <button type="button" className="min-h-touch rounded-lg border border-floor-line px-3 font-bold" onClick={() => void window.floorDesktop?.marketplaceBack()}>
            Back
          </button>
          <button type="submit" className="min-h-touch rounded-lg bg-floor-accent px-4 font-black text-black">
            Go
          </button>
        </form>
      ) : null}
      <div className="grid gap-3 lg:grid-cols-[320px_1fr]">
        <div>
          <SkuKeypad value={sku} onChange={setSku} />
          <div className="mt-3">
            <UnitPreview unit={unit} missing={missing} />
          </div>
          {unit ? (
            <div className="mt-3 grid gap-2">
              <p>
                Photos: {unit.photoCount ? unit.photoCount : <EmptyValue />}
                {!hasPhotos(unit) ? <span className="block font-bold text-floor-danger">Photos required before listing</span> : null}
              </p>
              <p className="text-sm text-floor-mute">
                {channel}: {listing?.state ?? "NOT_LISTED"}
              </p>
              <pre className="whitespace-pre-wrap rounded-lg border border-floor-line bg-black p-3 text-sm">{listingText(unit)}</pre>
              <button type="button" className="min-h-touch rounded-lg border border-floor-line font-bold" onClick={() => void copyListing()}>
                Copy listing text
              </button>
              <button type="button" className="min-h-touch rounded-lg bg-floor-accent font-black text-black" onClick={() => void mark("LISTED")}>
                Mark listed
              </button>
              <button type="button" className="min-h-touch rounded-lg border border-floor-line font-bold" onClick={() => void mark("ENDED")}>
                Mark ended
              </button>
              {copied ? <p className="text-floor-ok">{copied}</p> : null}
              {error ? <p className="font-bold text-floor-danger">{error}</p> : null}
            </div>
          ) : null}
        </div>
        <div ref={hole} className="min-h-[420px] rounded-xl border border-floor-line bg-black/40">
          {desktop ? null : (
            <p className="p-4 text-floor-mute">
              Open Floor desktop to browse {channel} here. Copy-paste listing text still works in this window.
            </p>
          )}
        </div>
      </div>
    </Shell>
  );
}
