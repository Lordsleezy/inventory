# Listing export (PC)

Pulls this store’s units and photos out of Supabase so you can prep Facebook Marketplace and other channel listings on a computer. Sold units are skipped unless you ask for them.

The service role key stays in your environment. It is never committed.

## What you get

A timestamped folder under `exports/` (gitignored), for example `exports/listings-20260917-1910/`:

```
README.txt
listings.csv
listings.xlsx
missing-photos.txt          (only if a download failed)
photos/
  11203-whirlpool-wrs325/
    11203-01.jpg            (primary first)
    11203-02.jpg
```

Each spreadsheet row is one unit:

| Column | Content |
|---|---|
| sku | SKU |
| brand, model, title | As entered on the phone |
| category, condition, test_status, defect_notes | As entered |
| ask_price, msrp | Dollar strings like `$449.00`, blank if unpriced |
| listed_on | Channels currently marked listed (not floor) |
| photo_folder | Folder name under `photos/` |
| photo_files | `11203-01.jpg; 11203-02.jpg` |
| listing_title | Ready to paste as the Marketplace title |
| listing_description | Ready to paste as the body (includes defects, ask, SKU) |

Photo folders are `{sku}-{brand}-{model}` in lowercase, e.g. `11203-whirlpool-wrs325`. The primary photo is always `01`.

## Run it (Windows PowerShell)

From the repo root. Copy **STORE_ID** from Setup in the app. The service role is in Supabase → Project Settings → API (secret). Do not paste it into git.

```powershell
cd C:\Users\pgg12\Desktop\everything\liquidation-os
$env:SUPABASE_URL = "https://zoukmsmbztcuyoslvikp.supabase.co"
$env:SUPABASE_SERVICE_ROLE = "paste-service-role-here"
$env:STORE_ID = "paste-store-uuid-from-setup"
npm run export:listings
```

Include sold units:

```powershell
npm run export:listings -- --sold
```

Write somewhere else:

```powershell
npm run export:listings -- --out D:\listings\this-week
```

Equivalent without npm:

```powershell
node --experimental-strip-types scripts/export-listings.mjs
node --experimental-strip-types scripts/export-listings.mjs --sold
```

You can also put `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE`, and `STORE_ID` in a local `.env` file and load them yourself. `.env` is gitignored. Do not commit it.

## Using the files

1. Open `listings.xlsx` (or the CSV) in Excel.
2. For each row, copy `listing_title` and `listing_description` into the channel.
3. Attach images from that row’s `photo_folder`, starting with `01`.
4. If `missing-photos.txt` exists, those SKUs need a reshoot or a storage check (`npm run` is not required; use `scripts/verify-photos.mjs`).

Cleanup of dirt / white backgrounds is a separate pass. It is not part of this export. Cleaned files, when you approve that work, will go in a `clean/` subfolder and will not overwrite these originals.
