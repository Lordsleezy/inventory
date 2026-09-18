# Listing export and photo round-trip (PC)

The service role key stays in gitignored `.env.local`. It is never committed and never sent to a review page.

## Desktop layout

Export writes unzipped files to `Desktop\floor-photos`:

```
listings.csv
listings.xlsx
manifest.json
README.txt
missing-photos.txt          (only if a download failed)
11203-whirlpool-wrs325/
  11203-01.jpg              (primary first)
  11203-02.jpg
```

Devin (or anyone) reads those folders and writes edited copies to `Desktop\floor-photos-clean` using the **same folder and file names**.

`manifest.json` maps each `folder` + `file` to the Supabase `photos` row (`id`, `storagePath`, `isPrimary`). Upload-back only touches files that match the manifest.

## Credentials

Paste the service role into:

`C:\Users\pgg12\Desktop\everything\liquidation-os\.env.local`

```
SUPABASE_URL=https://zoukmsmbztcuyoslvikp.supabase.co
SUPABASE_SERVICE_ROLE=
STORE_ID=
```

`STORE_ID` is the uuid from Setup in the app. `.env.local` is gitignored.

## Export

```
npm run export:listings
```

Sold units are skipped unless you pass `--sold`. Optional: `--only 11203,10421` or `--out D:\somewhere`.

## Upload clean photos

1. Preview a few before/after pairs (localhost; no key in the page): `npm run photos:preview` → `http://127.0.0.1:8788/`
2. After a go-ahead: `npm run photos:upload`

Upload copies the current live object to `{store_id}/archive/{sku}/...` (not anon-readable), writes a **new versioned** live key `{store_id}/{sku}/{file}-v2.jpg` (cache-safe), keeps order and primary, and points `photos.path` at the new key. `photos.original_path` is the archive. Missing or renamed clean files are skipped and listed. Extra files not in the manifest are not uploaded.

## Optional local rembg pass

`npm run photos:clean` still exists for a rembg+Sharp pass inside an export folder. Cutout can swap to Photoroom Basic ($0.02/image). Clipdrop Cleanup is 1 credit/image (~$0.02–$0.05 after 100 free) and is skipped without `CLIPDROP_API_KEY`.
