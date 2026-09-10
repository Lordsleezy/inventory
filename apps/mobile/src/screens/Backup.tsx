import { useState } from "react";
import {
  assertRestorable,
  exportSnapshot,
  historyCsv,
  restoreSnapshot,
  salesCsv,
  skuLedgerCsv,
  unitsCsv,
  type Snapshot,
} from "@floor/store";
import { readPickedTextFile, saveAndShare, stampedName } from "../files";
import { readPhotoBase64, writePhotoBase64 } from "../photos";
import { useStore } from "../store";
import { DangerButton, Label, Notice } from "../components/ui";

export function BackupScreen() {
  const { db, reloadSettings } = useStore();
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  async function run(what: string, fn: () => Promise<string>) {
    setError("");
    setNote("");
    setBusy(what);
    try {
      setNote(await fn());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("");
    }
  }

  async function csv(prefix: string, build: () => Promise<string>) {
    const file = await saveAndShare(
      stampedName(prefix, "csv"),
      await build(),
      "text/csv",
      "Floor export",
    );
    return `Saved ${file.filename} to ${file.where}.`;
  }

  async function backup(withPhotos: boolean) {
    const snapshot = await exportSnapshot(db);

    if (withPhotos) {
      const photoData: Record<string, string> = {};
      const missing: string[] = [];
      for (const path of snapshot.photoPaths) {
        try {
          photoData[path] = await readPhotoBase64(path);
        } catch {
          missing.push(path);
        }
      }
      snapshot.photoData = photoData;
      const file = await saveAndShare(
        stampedName("floor-backup-full", "json"),
        JSON.stringify(snapshot),
        "application/json",
        "Floor backup",
      );
      const counts = summarize(snapshot);
      return `Saved ${file.filename} to ${file.where}. ${counts}, ${Object.keys(photoData).length} photos${
        missing.length ? `, ${missing.length} photo files missing` : ""
      }.`;
    }

    const file = await saveAndShare(
      stampedName("floor-backup", "json"),
      JSON.stringify(snapshot),
      "application/json",
      "Floor backup",
    );
    return `Saved ${file.filename} to ${file.where}. ${summarize(snapshot)}.`;
  }

  async function restore() {
    const picked = await readPickedTextFile();
    if (!picked) return "Nothing selected. Your data was not touched.";

    let parsed: Snapshot;
    try {
      parsed = assertRestorable(JSON.parse(picked.text));
    } catch (err) {
      throw new Error(
        `${picked.name} could not be read: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const written = await restoreSnapshot(db, parsed);

    let photos = 0;
    for (const [path, base64] of Object.entries(parsed.photoData ?? {})) {
      try {
        await writePhotoBase64(path, base64);
        photos += 1;
      } catch {
        /* a photo that will not write should not abort a good restore */
      }
    }

    await reloadSettings();
    const units = written.units ?? 0;
    const sales = written.sales ?? 0;
    return `Restored ${units} units, ${sales} sales${photos ? `, ${photos} photos` : ""} from ${picked.name}.`;
  }

  return (
    <section>
      <h1 className="text-title">Export and back up</h1>
      <p className="mt-1 text-quiet text-floor-mute">
        This phone holds the only copy of your inventory. A backup you have actually moved somewhere
        else is the only thing that survives a lost or broken phone.
      </p>

      <Notice tone="error">{error}</Notice>
      <Notice tone="ok">{note}</Notice>
      {busy ? <p className="py-2 text-quiet text-floor-mute">{busy}…</p> : null}

      <div className="mt-5 border-b border-floor-line py-3">
        <Label>Full backup</Label>
        <p className="text-quiet text-floor-mute">
          Everything needed to rebuild on a new phone: units, sales, the SKU ledger and all history.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-4">
          <button
            type="button"
            className="btn-accent"
            disabled={!!busy}
            onClick={() => void run("Building backup", () => backup(false))}
          >
            Back up records
          </button>
          <button
            type="button"
            className="btn-text px-0"
            disabled={!!busy}
            onClick={() => void run("Building backup with photos", () => backup(true))}
          >
            Include photos
          </button>
        </div>
        <p className="mt-2 text-quiet text-floor-mute">
          With photos it is one self-contained file, but a much larger one. Without them it is small
          enough to send every day.
        </p>
      </div>

      <div className="border-b border-floor-line py-3">
        <Label>Spreadsheets</Label>
        <div className="mt-2 flex flex-wrap items-center gap-4">
          <button type="button" className="btn-text px-0" disabled={!!busy} onClick={() => void run("Exporting units", () => csv("floor-units", () => unitsCsv(db)))}>
            Units CSV
          </button>
          <button type="button" className="btn-text px-0" disabled={!!busy} onClick={() => void run("Exporting sales", () => csv("floor-sales", () => salesCsv(db)))}>
            Sales CSV
          </button>
          <button type="button" className="btn-text px-0" disabled={!!busy} onClick={() => void run("Exporting history", () => csv("floor-history", () => historyCsv(db)))}>
            History CSV
          </button>
          <button type="button" className="btn-text px-0" disabled={!!busy} onClick={() => void run("Exporting ledger", () => csv("floor-sku-ledger", () => skuLedgerCsv(db)))}>
            SKU ledger CSV
          </button>
        </div>
      </div>

      <div className="py-4">
        <Label>Restore</Label>
        <p className="text-quiet text-floor-mute">
          Replaces everything on this phone with the contents of a backup file. Use it on a new
          phone, or after a loss. Export a fresh backup first if there is anything here worth keeping.
        </p>
        <div className="mt-2">
          <DangerButton
            idle="Restore from a backup file"
            confirm="Choose file and replace everything"
            disabled={!!busy}
            onConfirm={() => void run("Restoring", restore)}
          />
        </div>
      </div>
    </section>
  );
}

function summarize(snapshot: Snapshot): string {
  const units = snapshot.counts.units ?? 0;
  const sales = snapshot.counts.sales ?? 0;
  const skus = snapshot.counts.sku_ledger ?? 0;
  return `${units} units, ${sales} sales, ${skus} SKUs ever issued`;
}
