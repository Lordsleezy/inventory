# Publishing the Floor functions site

The live functions site is `inventoryobi` (`admin` calls it through `inventoryobi.netlify.app`). The admin website is a different Netlify site. This guide is only for the functions site.

## Why a deploy can go live with no functions

`netlify deploy --prod --dir some-folder` uploads that folder as the website and does not upload functions unless you also pass `--functions`. Netlify then treats that upload as the new production deploy, so the previous functions disappear.

Functions that export `handler` run in Netlify's old Lambda compatibility mode. That mode still has AWS's 4KB cap on the combined size of environment variables. If the cap is exceeded, Netlify cannot create those functions. If every function fails, the deploy can go live with none. Removing variables gets the total back under 4KB, which is why that looked like a fix. The current Netlify runtime does not have that cap. A function reaches it by exporting `default` and not exporting `handler`. This repo's functions now do that.

## Emergency recovery only

The merge to `master` is the only routine production deploy. Do not run a manual Netlify deploy to publish application changes. The guarded scripts below exist only for Paul-approved emergency recovery.

For an emergency recovery, from a clean checkout of the latest `origin/master`:

```
node scripts/deploy-prod-netlify.mjs
```

That builds and checks the function bundle, then stops. It does not publish.

To publish after that check says ok, only with Paul's approval and this explicit environment flag:

```
FLOOR_EMERGENCY_DEPLOY=yes-paul-approved
node scripts/deploy-prod-netlify.mjs --confirm-prod
```

The script refuses to run unless git matches `origin/master` with no local edits. It refuses if any function is missing, if the built bundle is empty, or if the bundle has fewer functions than `scripts/function-manifest.json`.

When a function is added or removed on purpose, run `node scripts/write-function-manifest.mjs` and commit the updated `scripts/function-manifest.json` in the same change. The test fails if the file is stale.

## Roll back

1. Run `node scripts/rollback-prod-netlify.mjs --list`
2. Pick a production deploy whose state is `ready` and that was known to have functions.
3. Run `node scripts/rollback-prod-netlify.mjs --deploy-id THE_ID`
4. That prints the deploy and does not change production.
5. After you approve it, run the same command with `--confirm`.

Rollback restores a previous Netlify deploy. It does not upload the folder on this computer, so it cannot repeat the empty-functions upload.

Do not delete environment variables to make a deploy fit. Do not publish with `--dir` unless `--functions` points at a bundle this guard has already counted.
