/**
 * Vendoo export retired — marketplaces are eBay, Depop, Amazon, and TikTok Shop.
 * Stub so leftover imports show a clear message instead of a live export.
 */
type Props = { client?: unknown; compact?: boolean };

export function VendooExportPanel({ compact }: Props) {
  return (
    <section className="panel">
      <h2>Vendoo export (retired)</h2>
      {compact ? (
        <p className="hint">Vendoo export is retired. List on eBay, Depop, Amazon, or TikTok Shop.</p>
      ) : (
        <p>
          Vendoo and Mercari are no longer listing targets. Use eBay, Depop, Amazon, and TikTok Shop
          (plus the website and register). Historical Mercari sales still appear in Orders via email ingest.
        </p>
      )}
    </section>
  );
}
