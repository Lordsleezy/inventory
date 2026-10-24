# Preserved unapplied migrations

These SQL files were tracked under `supabase/migrations`, but their version numbers were absent from the live `floor` migration ledger as of 2026-10-24. Most overlap changes already applied to live under earlier versions. They are preserved unchanged for review and must not be run as a group against production.

The runnable migration directory now contains the SQL recorded in the live migration ledger for its previously missing 149 versions. Before restoring any change from this directory, compare it with the live schema and create a new migration on `master` for only the missing behavior.
