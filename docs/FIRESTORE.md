# Firestore persistence

Public rankings load through the Firebase browser SDK. Owner login and saves use the Catan API with environment-configured credentials and the existing Firebase Admin service-account JSON. Follow [the environment setup](VERCEL.md); no Firebase Authentication or owner UID configuration is required.

## Existing data

The database is `inventory-management-6626b`, default Firestore database. Public records remain at:

```text
catan/rankings                    schema/version/revision/playerIds/gameIds
catan/rankings/players/{id}       player ID and name
catan/rankings/games/{id}         date, notes, participants, VP breakdowns
```

The browser and server use the existing `catan-rankings-v1` schema. Do not delete or recreate the ledger while changing connection settings. An empty ledger is initialized by the owner's first API save. Incompatible metadata, incomplete indexes, orphan records and invalid VP data are rejected before saving.

Only those three paths receive public client reads. The [rules template](../firestore.rules.example) grants no client writes and no client access to room state, sessions, rate limits or nested record subcollections. Preserve the rules for unrelated collections when merging it. Admin SDK operations are authorized by Google IAM and bypass client Security Rules. [Firestore server access](https://firebase.google.com/docs/firestore/security/get-started).

## Reads, saves and conflicts

Public reads use server-confirmed Firestore results, validate record indexes and retry if the metadata revision changes while loading. Owner saves go to the same-origin API. The server validates the complete ledger and uses a Firestore transaction to compare revisions, write changed records, delete removed records and increment metadata atomically.

A stale owner tab receives a conflict and retains its draft. A save can change at most 449 player/game documents plus one metadata document, with a conservative request-size guard. The ledger supports up to 500 players and 2,000 games. It is loaded in full; large archives will need pagination before reaching request-size limits.

A successful save means Firestore acknowledged the write. An uncertain network failure requires reloading before retrying. There is no fallback to browser storage or local files on a cloud error. Records survive browser closure, application restarts and Vercel redeployments. Backups remain necessary to recover deletions.

## Server configuration and owner access

Set `RANKINGS_STORAGE=firestore`, `FIREBASE_AUTH_MODE=admin`, `FIRESTORE_RANKINGS_DOCUMENT=catan/rankings` and the server-only `FIREBASE_SERVICE_ACCOUNT_JSON` Secret. The required `FIREBASE_PROJECT_ID=inventory-management-6626b` must match the JSON credential. Set `RANKINGS_ADMIN_USERNAME` and `RANKINGS_ADMIN_PASSWORD` as Secrets; use at least ten password characters. The [Vercel guide](VERCEL.md#environment-variables) lists public and server fields separately.

Owner sessions last twelve hours in HTTP-only cookies. Firestore stores session hashes and shared login limits, so authorization survives function instance changes. Signing out revokes the session. Changing owner credentials and redeploying invalidates earlier sessions on the updated deployment. Passwords and service-account keys never belong in `VITE_*` variables or Git.

For local development, `GOOGLE_APPLICATION_CREDENTIALS` may point to the existing JSON file outside the repository instead of storing its contents in `FIREBASE_SERVICE_ACCOUNT_JSON`. Configure only one credential source. Keep `FIREBASE_AUTH_MODE=admin` and the same project/document settings.

## Local files and imports

Local Node installations can use `VITE_RANKINGS_TRANSPORT=http` with `RANKINGS_STORAGE=file`. Rankings then live in `CATAN_DATA_DIR/rankings.json`. File writes use atomic replacement, and hosted file storage needs a persistent disk. The owner login still uses the same server environment variables.

The `rankings:import` command remains an explicit maintenance operation. Read its `--help`, review the target and backup, and use an authorized local Admin connection before importing an old JSON ledger. Enabling Firestore does not import, delete or rewrite existing local files automatically.

Socket.IO rooms remain in `CATAN_DATA_DIR/rooms.json`; Vercel HTTP rooms persist in private Firestore documents. Local pass-and-play stays in browser storage. Rankings do not expire when rooms expire.

## Emulator verification

The browser rules fixture is generated from the exact read-only production template. Start the isolated Firestore emulator and run SDK/API and UI checks sequentially:

```sh
npm run firebase:browser:rules
firebase emulators:start --only firestore --project demo-catan-browser --config firebase.browser.emulator.json
# In another terminal:
npm run test:firebase-browser
npm run test:firebase-browser-ui
```

These tests use the actual browser read path and environment-based HTTP owner flow. They verify public reads, denied direct client writes, private-subcollection denial, owner CRUD, conflict handling and persistence. No Auth emulator, real credential or production rules publication is involved. Run suites sequentially because each cleans the same demo ledger.

`npm run test:firestore` verifies server transactions, shared owner sessions, credential rotation and safe import against its separate local Firestore emulator configuration. `npm run test:rankings` verifies the HTTP API and desktop/mobile editing with temporary file storage. It explicitly builds `VITE_RANKINGS_TRANSPORT=http`; build normally again before deploying the hybrid Firebase variant.
