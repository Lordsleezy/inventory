# Floor on iPhone

Floor is a standalone iOS app. Inventory, sales, photos, history, and the SKU
ledger all live in a SQLite file on the phone. There is no Surface, no
InvenTree, and no network required.

Losing this phone without a backup means losing the store. Use **Setup → Export
and back up** and get that file off the device.

## What the database will not allow

These are SQLite constraints, not UI checks:

- A SKU cannot be sold twice. The live-sale unique index makes a second sale
  unrepresentable. Void the first sale first.
- A SKU is never reused. Deleting a unit does not free its number.
- History is append-only. Price, condition, status, and location changes are
  kept with a timestamp. They cannot be edited or deleted.
- Money is integer cents. An empty price is empty, never `$0.00`.
- There is no quantity field. Five identical items are five units.

## Build the ipa (Codemagic)

This Windows machine cannot archive an ipa. Codemagic (macOS) does.

### Apple Developer (team `4SRR4NV35F`)

1. App ID `com.openboxindustries.floor` and the App Store Connect record already exist.
2. [codemagic.io](https://codemagic.io/login) → add GitHub repo `Lordsleezy/inventory`.
3. Teams → integrations → **Apple Developer Portal** → sign in (2FA). Codemagic
   issues the Distribution cert and App Store profile.
4. App settings → `codemagic.yaml` workflow **ios-capacitor** → Start build, or
   push a tag `ios-*`.
5. TestFlight: enable the App Store Connect integration so the ipa is submitted
   automatically. Install **TestFlight** on the iPhone.

Pipeline: `npm ci` → store tests → `npm run build -w @floor/mobile` →
`npx cap add ios` if needed → `npx cap sync ios` → `scripts/ios-prepare.sh` →
archive ipa.

`apps/adapter/ios/` and `apps/adapter/www/` are generated and gitignored.

## After install

1. Receive a unit. The next five-digit SKU is offered; you can type a different
   unused one.
2. Photos come from the camera or the camera roll and are stored as files next
   to the database.
3. Mark sold with channel and the actual price. A second sale of that SKU is
   refused by the database.
4. Sales → Receipt opens a printable page (AirPrint / Save PDF).
5. Setup holds categories, conditions, locations, channels — none of them are
   hardcoded to appliances.
6. Export and back up. Move the file to iCloud Drive, a computer, or email.
   Restore replaces everything on the phone with that file.

iOS device backups include the Documents folder, so an iCloud/Finder backup of
the phone includes the database. That is not a substitute for an export you
have actually moved somewhere else.
