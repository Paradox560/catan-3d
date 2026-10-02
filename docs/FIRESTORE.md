# Store Catan rankings in Firestore

The rankings API stores its ledger in Cloud Firestore. The Vercel deployment uses **standard Firebase web config and keyless platform authentication**. Vercel OIDC and Google Workload Identity Federation supply short-lived Google credentials after a one-time IAM trust setup. No Firebase backend account, service-account JSON, or private key is required. Visitors read the Catan API, and the configured website owner username and password authorize edits.

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

The public rankings API never returns these private documents. Plaintext owner passwords and platform access tokens are not saved in Firestore. Player/game records have no automatic expiry. Transient documents use `expiresAt` timestamps; the app enforces expiry even without optional Firestore TTL cleanup.

Vercel online rooms use Firestore. The standard Node/Socket.IO server continues to save rooms to `CATAN_DATA_DIR/rooms.json`, and local pass-and-play remains in browser storage.

## Authentication modes

### Web config and Vercel platform identity

Supply the standard Firebase Console web config using [the listed environment names](VERCEL.md#vercel-environment-variables) or `FIREBASE_CONFIG` JSON. On Vercel, Firestore storage and `catan/rankings` are defaults; web config selects the keyless authentication mode. The usual `appId` supplies the Google project number, and an optional `messagingSenderId` must agree with it. No extra pool, provider, service-account email, backend username/password, or key variable is needed.

A **one-time Google Cloud IAM trust setup is required**. Run the reviewed helper in [the deployment guide](VERCEL.md#one-time-google-cloud-trust-setup). It binds only the verified `pranavs-projects-e233eba1` team, `catan-3d` project, and production environment to a dedicated keyless service identity. Public web config alone is not authorization. No Firebase Authentication Email/Password provider or user needs to be created.

The helper grants six data/transaction permissions, conditioned on the existing `(default)` database. Firestore IAM cannot scope them to `catan/rankings`: other collections in that database fall within the same IAM grant. The application uses the Catan root, and a separate database plus deliberate migration is needed for stronger data isolation. The helper does not move records or alter an existing database.

The server obtains short-lived tokens from Vercel and Google; no persistent secret is stored. Invalid configuration, token exchange, or IAM permission returns an error without falling back to another identity or file storage. Document/query transactions, atomic commits, and revision conflicts are preserved.

### Legacy Admin SDK

Existing deployments may explicitly select `FIREBASE_AUTH_MODE=admin`. When no authentication mode or web-mode fields are configured, an existing Admin configuration remains compatible. Use one credential source:

- A Firebase Admin key file outside the repository, referenced by `GOOGLE_APPLICATION_CREDENTIALS`.
- The complete downloaded service-account JSON in the private `FIREBASE_SERVICE_ACCOUNT_JSON` environment variable.
- A Google-managed runtime identity through Application Default Credentials, with neither key variable set.

Admin mode uses IAM and bypasses Firestore Security Rules. Limit the service identity to the Firestore access the app needs. A supplied key must belong to the configured project. See [Firebase Admin setup](https://firebase.google.com/docs/admin/setup) and [Firestore IAM access control](https://cloud.google.com/firestore/native/docs/security/iam).

Keep any legacy private keys and owner passwords out of Git, frontend source, and `VITE_` variables. A key file is needed only when intentionally using that legacy Admin option.

## Website owner access

Set `RANKINGS_ADMIN_USERNAME` and `RANKINGS_ADMIN_PASSWORD` as private server variables. Choose a password of at least ten characters. These credentials control the **Owner sign in** form; Google database access uses the deployed platform identity. Missing or invalid owner values disable editing while configured public rankings remain readable.

In Firestore mode, owner sessions and sign-in rate limits are shared across instances. Cookies last twelve hours across cold starts and redeployments when owner values stay the same. Changing either owner value and redeploying invalidates prior cookies on the new deployment; signing out revokes that session everywhere. See [owner access, scoring, and recovery](RANKINGS.md).

## Configure and run locally

The production OIDC grant intentionally trusts only Vercel production. Local pass-and-play and `RANKINGS_STORAGE=file` need no cloud identity. For local Firestore development, use a loopback emulator or an explicit legacy Admin configuration from the options above. Existing local Admin settings remain compatible when no web-mode fields select keyless mode.

`npm start` and `npm run dev` load an ignored `.env` file; shell variables take precedence. Configure the website owner variables to enable local owner editing. Build and start with:

```sh
npm run build
npm start
```

Stop an existing server on port 3001 before restarting. Open [Rankings](http://localhost:3001/#rankings) and choose **Owner sign in**. Missing database credentials or permissions return an error without overwriting local records or switching storage.

## Import existing rankings

Back up `server/data/rankings.json`. The importer reads and validates that file, then checks the configured Firestore destination. Preview is the default; the source file and owner credentials are never changed or imported.

From an authorized environment with Firestore configured (for example, your existing local Admin setup):

```sh
npm run rankings:import -- --file ./server/data/rankings.json
npm run rankings:import -- --file ./server/data/rankings.json --apply
```

Read the preview before using `--apply`. The destination must be empty. An existing ledger or a concurrent save makes the import fail instead of overwriting records. After importing, verify player totals and game details on the website, then restart to check persistence.

A single import supports up to 449 combined players and games. A larger ledger is rejected before any write and needs a separate migration strategy. Ordinary edits write only changed records. The application currently transfers the complete ledger over HTTP, so a large archive needs pagination before reaching [Vercel's 4.5 MB payload ceiling](https://vercel.com/docs/functions/limitations).

## Deploy with Firestore

For **Vercel**, follow the [canonical deployment and environment guide](VERCEL.md). It lists the standard web config fields, owner credentials, and the one-time keyless IAM trust setup. Redeploy after changing environment values. The frontend build selects HTTP multiplayer automatically, and rankings, sessions, limits, and rooms survive replacement of the function because they live in Firestore.

For **Render or another long-running Node host**, the Vercel-specific production trust does not apply. Use an explicitly configured Admin identity or an independently reviewed identity federation setup for that host. This does not change the required configuration for the Vercel deployment.

The Node server's Socket.IO rooms still require one process and a persistent disk at `CATAN_DATA_DIR` to survive replacement. Firestore rankings and owner sessions are independent of that disk. Production owner cookies require HTTPS.

Keep database backups appropriate to your records: deployment persistence does not undo an intentional owner deletion. Firestore usage remains subject to project quotas and billing. Rankings read metadata and record documents; HTTP rooms read on each poll and occasionally update presence.

## Restrict direct client access

Firestore client Rules should deny direct access to `catan/rankings` and its descendants. Visitors use the Catan API. The keyless server and legacy Admin identities use Google IAM and bypass client Rules. Merge the scoped deny in [firestore.rules.example](../firestore.rules.example), preserving unrelated application rules.

Review broader matching allows: Rules are additive, so a narrow deny cannot override another allow. Neither the app nor the setup helper publishes rules. See [Firestore rules structure](https://firebase.google.com/docs/firestore/security/rules-structure).

## Emulator verification

Tests use loopback emulators and `demo-` projects with no cloud resources. Production rejects emulator configuration, and demo projects must use emulators. No tests use the real project, credentials, or rankings. See [Firebase emulator guidance](https://firebase.google.com/docs/emulator-suite/connect_firestore).

The keyless token flow is covered by mocked runtime tests. The setup helper has isolated tests for dry-run behavior, exact workload restrictions, and refusal of mismatched permissions. Neither test creates a real trust grant. Run:

```sh
node --test scripts/setup-vercel-firestore.test.mjs
```

For **legacy Admin mode**, start the separate Firestore-only emulator configuration:

```sh
firebase emulators:start --only firestore --project demo-catan-rankings --config firebase.emulator.json
```

In another terminal:

```sh
FIRESTORE_EMULATOR_HOST=127.0.0.1:8181 npm run test:firestore
```

The legacy suite covers owner-only API writes, concurrent revisions, restart persistence, shared sessions and logout, credential rotation, expiry, shared rate limits, corruption detection, and safe import. `npm test` also covers configuration validation, token handling, and REST transaction behavior. Remove emulator variables before starting the real server.
