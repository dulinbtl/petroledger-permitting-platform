# PetroLedger — Permitting Business Model (web app)

Single-page app (`public/index.html`) plus a small Node.js server (`server.js`, no npm packages)
that saves everything users do to shared storage, so the team works from one set of data.

## Run on Azure App Service (Linux, Node 24 LTS)
- Startup command: `node server.js`
- App setting `STORAGE_ACCOUNT_URL` = `https://<account>.blob.core.windows.net` (Azure Blob Storage).
- Turn on the web app's system-assigned managed identity and give it the
  **Storage Blob Data Contributor** role on the storage account (no keys or secrets).
- Optional `BLOB_CONTAINER` (default `permitting`; created on first start).
- Turn on App Service authentication (Microsoft Entra ID, single tenant, require authentication).
  The server records the signed-in person on every save.
- Without `STORAGE_ACCOUNT_URL`, data is saved as files under `/home/data/permitting` (single instance only).
- The API refuses to run on App Service unless built-in sign-in is on (`WEBSITE_AUTH_ENABLED`), because the
  identity headers could otherwise be forged. `TRUST_AUTH_HEADERS=1` overrides this for unusual setups only.

## Run locally
`node server.js` → http://localhost:8080 (files under `./data`, user "Local user").
Opening `public/index.html` directly as a file still works, saving only in that browser.

## API
| Method | Path | Purpose |
| --- | --- | --- |
| GET | /api/state | Everything: catalog, settings, actions, all proposals (with etags, who and when) |
| GET | /api/versions | Etags and who/when only — used to notice other people's saves |
| PUT | /api/docs/{catalog, settings, actions} | Save one document `{data, etag}` |
| PUT | /api/proposals/{id} | Save one proposal `{data, etag}` |
| DELETE | /api/proposals/{id}?etag= | Delete one proposal |
| GET | /api/me, /health | Signed-in user; health check |

A save sends the etag it last read; a stale etag gets `409` with the current version, and the app
asks the user to keep theirs or use the other person's. Changes require the header `X-PL-Client: 1`.

Storage layout: `docs/catalog.json`, `docs/settings.json`, `docs/actions.json`, `proposals/<id>.json`,
each `{data, updatedBy, updatedById, updatedAt}`.
