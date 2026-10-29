import type { SupabaseClient } from '@supabase/supabase-js';
import { parseManifestLines } from './manifestLines.ts';

export type BackfillManifest = { id: string; name: string; storage_path: string; content_type?: string; line_count: number };

/** Upload paths can be truncated before the extension; trust the stored MIME type too. */
export function isCsvManifestFile(manifest: Pick<BackfillManifest, 'storage_path' | 'content_type'>) {
  return /\.csv$/i.test(manifest.storage_path)
    || (manifest.content_type || '').split(';', 1)[0].trim().toLowerCase() === 'text/csv';
}

/** Runs only through admin-authorized list/storage/import APIs; never overwrites originals or imported lines. */
export async function backfillManifestFiles(client: SupabaseClient, manifests: BackfillManifest[]) {
  const outcomes: Record<string, string> = {};
  for (const manifest of manifests) {
    if (manifest.line_count > 0 || !isCsvManifestFile(manifest)) continue;
    try {
      const { data, error } = await client.storage.from('floor-manifests').download(manifest.storage_path);
      if (error || !data) throw new Error('Original CSV unavailable; re-upload this manifest.');
      const lines = parseManifestLines(await data.text());
      const result = await client.rpc('portal_import_manifest_lines', { p_id: manifest.id, p_lines: lines });
      if (result.error) throw result.error;
      outcomes[manifest.id] = `${result.data} lines saved from original CSV.`;
    } catch (error) {
      outcomes[manifest.id] = `Lines not imported: ${String((error as Error).message || error)}`;
    }
  }
  return outcomes;
}
