## Receive multiples

Receive 1–100 identical new units in one atomic save. Each gets its own normal SKU, stock row, photo links, finishing job and entered per-unit cost (admin only). Batches have durable group membership; a lost response replays the original complete SKU list, using one device recovery record. A failed batch transaction leaves no units or group.

- Repeat UPC scans offer an in-stock group template and let the receiver add a newly photographed batch.
- Inventory groups matching units into expandable rows. Counters remain physical unit totals; pagination counts display rows separately. Search/status/location filters apply before grouping.
- Individual details/photo edits detach that SKU. Selling does not detach historical membership or sell siblings.
- Admin group edits affect attached, in-stock units only; never costs, sales, payments or channel options. Each changed row is archived before the edit. Sold and detached units stay unchanged.
- Print labels produces a distinct Code 128 SKU label for each attached group member.
- Manifest progress is received/expected for the matching UPC; existing retail and defect-warning behavior stays read-only.
- Qty 1 without selecting a group follows the existing single-unit path and does not create an expandable group.

## Channel boundary

No channel listing/sync source files are modified. Bulk and add-more jobs have empty channel selections and website visibility false. They use normal independent SKUs and qty_on_hand=1; existing sale/delist logic therefore sees individual units, as before. No existing inventory is grouped or changed by migration.

Current channel sync is keyed by the individual SKU/listing. It does not consolidate siblings into a multi-quantity external listing, propagate a shared external quantity across a group, or map one shared external SKU to multiple Floor SKUs. Reusing one external listing for an entire group would require the separate future sync job. Keep individual SKU mappings until then. This implementation does not publish any batch.

## Tests

Added pgTAP coverage for clerk Qty 11, all-or-nothing late failure, full recovery replay, copied details/photos/manifest, admin costs, group expansion/counts, add more, independent edits, group edit authorization, per-row before-images and a real local register finalization with per-SKU ledger, commissions and Books entries. Existing receive recovery/stock-photo/title tests and manifest regressions remain in CI. Chromium tests exercise tap-only quantity, repeat group choice, group expansion and clerk/admin controls.

The newer master not-for-sale intake exception is preserved: brand-only not-for-sale stock may be received without photos or finishing jobs, including multiple units. Normal sale stock keeps its existing photo rules.
