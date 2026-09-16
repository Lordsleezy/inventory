"use client";

import { useState } from "react";
import { Shell } from "@/components/shell";
import type { ColumnMap, ImportField, ParsedImportRow } from "@floor/importer";
import { IMPORT_FIELDS } from "@floor/importer";

export default function ImportPage() {
  const [csv, setCsv] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [map, setMap] = useState<ColumnMap>({});
  const [preview, setPreview] = useState<ParsedImportRow[]>([]);
  const [results, setResults] = useState<{ sku: string | null; status: string; error: string | null; line: number }[]>([]);
  const [error, setError] = useState("");

  async function previewIt() {
    setError("");
    const res = await fetch("/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csv, map, commit: false }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Preview failed");
      return;
    }
    setHeaders(data.headers ?? []);
    setMap(data.map ?? {});
    setPreview(data.preview ?? []);
    setResults([]);
  }

  async function commit() {
    setError("");
    const res = await fetch("/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csv, map, commit: true }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Import failed — CSV kept");
      return;
    }
    setResults(data.results ?? []);
  }

  return (
    <Shell>
      <h1 className="mb-3 text-2xl font-black">Import</h1>
      <textarea
        value={csv}
        onChange={(e) => setCsv(e.target.value)}
        placeholder="Paste CSV"
        className="min-h-48 w-full rounded-lg border border-floor-line bg-black p-3 font-mono text-sm"
      />
      <label className="mt-2 block">
        <span className="text-sm text-floor-mute">Or load a file</span>
        <input
          type="file"
          accept=".csv,text/csv"
          className="mt-1 block"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setCsv(await file.text());
          }}
        />
      </label>
      {headers.length ? (
        <div className="mt-4 grid gap-2">
          {IMPORT_FIELDS.map((field) => (
            <label key={field} className="grid grid-cols-[140px_1fr] items-center gap-2">
              <span className="text-sm text-floor-mute">{field}</span>
              <select
                value={map[field as ImportField] ?? ""}
                onChange={(e) => setMap({ ...map, [field]: e.target.value || undefined })}
                className="min-h-touch rounded-lg border border-floor-line bg-floor-panel px-2"
              >
                <option value=""></option>
                {headers.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      ) : null}
      <div className="mt-3 flex gap-2">
        <button type="button" onClick={() => void previewIt()} className="min-h-touch rounded-lg bg-floor-accent px-4 font-black text-black">
          Preview
        </button>
        <button type="button" onClick={() => void commit()} className="min-h-touch rounded-lg border border-floor-line px-4 font-black">
          Import
        </button>
      </div>
      {error ? <p className="mt-2 font-bold text-floor-danger">{error}</p> : null}
      {preview.length ? (
        <p className="mt-3 text-sm text-floor-mute">
          {preview.length} rows, {preview.filter((r) => r.error).length} parse errors
        </p>
      ) : null}
      {results.length ? (
        <ul className="mt-3 grid gap-1 text-sm">
          {results.map((row) => (
            <li key={row.line} className={row.status === "error" ? "text-floor-danger" : "text-floor-ok"}>
              line {row.line} {row.sku ?? ""} {row.status}
              {row.error ? ` — ${row.error}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
    </Shell>
  );
}
