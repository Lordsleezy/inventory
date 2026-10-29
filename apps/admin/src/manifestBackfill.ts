import type { SupabaseClient } from '@supabase/supabase-js';
import { parseManifestLines } from './manifestLines.ts';

export type BackfillManifest = { id: string; name: string; storage_path: string; line_count: number };

/** Runs only through admin-authorized list/storage/import APIs; never overwrites originals or imported lines. */
export async function backfillManifestFiles(client: SupabaseClient, manifests: BackfillManifest[]) {
  const outcomes: Record<string, string> = {};
  for (const manifest of manifests) {
    if (manifest.line_count > 0 || !/\.csv$/i.test(manifest.storage_path)) continue;
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
