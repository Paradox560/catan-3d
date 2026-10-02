# Store Catan rankings in Firestore

The rankings API stores its ledger in Cloud Firestore. The default deployment uses **Firebase web config plus a dedicated Firebase Authentication backend account**. The server obtains an ID token and sends Firestore REST requests authorized by Security Rules. No service-account JSON or private key is required in this mode. Visitors read the Catan API, and the configured website owner username and password authorize edits.

The destination for this project is:

| Setting             | Value                        |
| ------------------- | ---------------------------- |
| Firebase project ID | `inventory-management-6626b` |
| Firestore database  | `(default)`                  |
| Collection          | `catan`                      |
| Rankings document   | `catan/rankings`             |

`catan` is a collection, so the app uses `rankings` as its document name. Ledger metadata lives in that document; player and game records live in its `players` and `games` subcollections. Changing authentication mode does not move or recreate these records. Other documents in the collection are left alone.

The same root contains private operational subcollections:

- `ownerSessions`: hashed owner-cookie identifiers, credential fingerprints, and expiry times.
- `ownerRateLimits`: owner sign-in attempt limits shared across server instances.
- `onlineRooms`: authoritative room state for Vercel's HTTP transport, including hashed seat credentials and private hands.
- `onlineLimits`: shared room creation and command limits.

The public rankings API never returns these private documents. Plaintext owner and backend passwords are not saved in Firestore. Player/game records have no automatic expiry. Transient documents use `expiresAt` timestamps; the app enforces expiry even without optional Firestore TTL cleanup.

Vercel online rooms use Firestore. The standard Node/Socket.IO server continues to save rooms to `CATAN_DATA_DIR/rooms.json`, and local pass-and-play remains in browser storage.

## Authentication modes

### Web config and Firebase Authentication

Select `FIREBASE_AUTH_MODE=web`. Follow the [one-time Firebase account and rules setup](VERCEL.md#one-time-firebase-setup), then configure the [listed web fields and backend account variables](VERCEL.md#vercel-environment-variables). The Firebase Console web config identifies your app; the dedicated Email/Password backend account and its exact UID authorize database access.

The backend requires `FIREBASE_BACKEND_EMAIL`, `FIREBASE_BACKEND_PASSWORD`, and `FIREBASE_BACKEND_UID`. Its password is a server-only secret. Use an account separate from the website owner login. Firebase API keys do not replace this account or Firestore Rules. The app checks the configured UID and token project, and never creates a user or changes rules automatically.

Supply the web config as individual fields or the `FIREBASE_CONFIG` JSON alternative described in the deployment guide. Do not mix those sources. Remove `FIREBASE_SERVICE_ACCOUNT_JSON` and `GOOGLE_APPLICATION_CREDENTIALS` in web mode. An invalid web configuration or failed sign-in returns an error; it never falls back to Admin credentials or local files.

The backend caches sign-in and refreshes ID tokens through Firebase Authentication. Database operations retain transactional document/query reads, atomic commits, and optimistic revision checks. Only confirmed Firestore concurrency aborts are retried; an uncertain commit is not replayed automatically.

### Legacy Admin SDK

Existing deployments may explicitly select `FIREBASE_AUTH_MODE=admin`. When no authentication mode or web-mode fields are configured, an existing Admin configuration remains compatible. Use one credential source:

- A Firebase Admin key file outside the repository, referenced by `GOOGLE_APPLICATION_CREDENTIALS`.
- The complete downloaded service-account JSON in the private `FIREBASE_SERVICE_ACCOUNT_JSON` environment variable.
- A Google-managed runtime identity through Application Default Credentials, with neither key variable set.

Admin mode uses IAM and bypasses Firestore Security Rules. Limit the service identity to the Firestore access the app needs. A supplied key must belong to the configured project. See [Firebase Admin setup](https://firebase.google.com/docs/admin/setup) and [Firestore IAM access control](https://cloud.google.com/firestore/native/docs/security/iam).

Keep private keys, backend passwords, and owner passwords out of Git, frontend source, and `VITE_` variables. A key file is needed only when intentionally using that legacy Admin option.

## Website owner access

Set `RANKINGS_ADMIN_USERNAME` and `RANKINGS_ADMIN_PASSWORD` as private server variables. Choose a password of at least ten characters. These credentials control the **Owner sign in** form; they are separate from the Firebase backend account. Missing or invalid owner values disable editing while configured public rankings remain readable.

In Firestore mode, owner sessions and sign-in rate limits are shared across instances. Cookies last twelve hours across cold starts and redeployments when owner values stay the same. Changing either owner value and redeploying invalidates prior cookies on the new deployment; signing out revokes that session everywhere. See [owner access, scoring, and recovery](RANKINGS.md).

## Configure and run locally

Complete the same [Firebase account and rules setup](VERCEL.md#one-time-firebase-setup) used for Vercel. Copy `.env.example` to the ignored `.env`, set `NODE_ENV=development` and `RANKINGS_STORAGE=firestore`, and fill its web config, backend account, document path, and owner settings. The destination remains `inventory-management-6626b` / `catan/rankings`. `FIRESTORE_DATABASE_ID` is optional and defaults to `(default)`.

Leave `FIREBASE_AUTH_EMULATOR_HOST` and `FIRESTORE_EMULATOR_HOST` unset when connecting to the real database. Ensure that Firestore exists, Email/Password sign-in is enabled, the backend user exists, and its UID matches the published scoped rules.

If you already have recorded JSON games, import them before making new Firestore records. Otherwise build and start:

```sh
npm run build
npm start
```

Stop the existing server on port 3001 before restarting. Open [the rankings page](http://localhost:3001/#rankings), choose **Owner sign in**, and use the website owner variables. `npm start` and `npm run dev` load `.env`; shell or hosting variables take precedence.

`RANKINGS_STORAGE=file` retains local JSON storage without Firebase. `firestore` explicitly selects the remote database. Missing credentials, rejected rules, or an unavailable database return an error without overwriting local records or switching storage.

## Import existing rankings

Back up `server/data/rankings.json`. The importer reads and validates that file, then checks the configured Firestore destination. Preview is the default; the source file and owner credentials are never changed or imported.

With either supported Firestore authentication mode configured in `.env` or the environment:

```sh
npm run rankings:import -- --file ./server/data/rankings.json
npm run rankings:import -- --file ./server/data/rankings.json --apply
```

Read the preview before using `--apply`. The destination must be empty. An existing ledger or a concurrent save makes the import fail instead of overwriting records. After importing, verify player totals and game details on the website, then restart to check persistence.

A single import supports up to 449 combined players and games. A larger ledger is rejected before any write and needs a separate migration strategy. Ordinary edits write only changed records. The application currently transfers the complete ledger over HTTP, so a large archive needs pagination before reaching [Vercel's 4.5 MB payload ceiling](https://vercel.com/docs/functions/limitations).

## Deploy with Firestore

For **Vercel**, follow the [canonical deployment and environment guide](VERCEL.md). It lists web config fields, backend account values, owner credentials, and Firestore Rules setup. Redeploy after changing environment values. The frontend build selects HTTP multiplayer automatically, and rankings, sessions, limits, and rooms survive replacement of the function because they live in Firestore.

For **Render or another long-running Node host**, use the same web-mode Firebase and owner values and serve over HTTPS. The Render Blueprint defaults to web mode and prompts for the app fields, backend email/password/UID, and both owner values. On an existing Render service, update its environment settings manually. See [Render's secret configuration](https://render.com/docs/blueprint-spec#prompting-for-secret-values). Legacy Admin deployments can instead select `FIREBASE_AUTH_MODE=admin` and one of the credential sources above.

The Node server's Socket.IO rooms still require one process and a persistent disk at `CATAN_DATA_DIR` to survive replacement. Firestore rankings and owner sessions are independent of that disk. Production owner cookies require HTTPS.

Keep database backups appropriate to your records: deployment persistence does not undo an intentional owner deletion. Firestore usage remains subject to project quotas and billing. Rankings read metadata and record documents; HTTP rooms read on each poll and occasionally update presence.

## Restrict direct client access

In web mode, Firestore Rules must grant the dedicated backend UID access to `catan/rankings` and its descendants, while denying anonymous and unrelated Firebase users. Use the scoped match and setup instructions in [the deployment guide](VERCEL.md#one-time-firebase-setup) and [rules example](../firestore.rules.example). An unconditional deny would also block this web-mode backend.

Preserve other applications' rules when merging that match. Rules are additive: a broader matching allow still grants access, so a narrow deny cannot cancel it. Review broad `/{document=**}` permissions. The app never publishes rules automatically. See [Firestore Security Rules structure](https://firebase.google.com/docs/firestore/security/rules-structure).

With legacy Admin mode, Firestore Rules do not authorize the server; IAM does. Direct browser access can remain denied entirely in that mode. Visitors always use the Catan API for public rankings, owner editing, and legal game actions.

## Emulator verification

Tests use loopback emulators and `demo-` projects with no cloud resources. Production rejects emulator configuration, and demo projects must use emulators. No tests use the real project, credentials, or rankings. See [Firebase emulator guidance](https://firebase.google.com/docs/emulator-suite/connect_firestore).

For **web mode**, start both Auth and Firestore using the [documented web-mode commands](VERCEL.md#verification), then run `npm run test:firebase-web` with the two emulator host variables. This exercises backend sign-in, token identity, scoped access rules, REST transactions, and persistence. Its test UID belongs only to the emulator fixture.

For **legacy Admin mode**, start the separate Firestore-only emulator configuration:

```sh
firebase emulators:start --only firestore --project demo-catan-rankings --config firebase.emulator.json
```

In another terminal:

```sh
FIRESTORE_EMULATOR_HOST=127.0.0.1:8181 npm run test:firestore
```

The legacy suite covers owner-only API writes, concurrent revisions, restart persistence, shared sessions and logout, credential rotation, expiry, shared rate limits, corruption detection, and safe import. `npm test` also covers configuration validation, token handling, and REST transaction behavior. Remove emulator variables before starting the real server.
