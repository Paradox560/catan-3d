# Store Catan rankings in Firestore

The rankings API can store its ledger in Cloud Firestore. The Node server uses Firebase Admin; the browser continues to read the public rankings API, and only the configured owner username and password authorize changes. Player names, recorded dates, notes, and VP breakdowns remain editable through the existing page.

The configured destination for this project is:

| Setting             | Value                        |
| ------------------- | ---------------------------- |
| Firebase project ID | `inventory-management-6626b` |
| Firestore database  | `(default)`                  |
| Collection          | `catan`                      |
| Rankings document   | `catan/rankings`             |

`catan` is a collection, so the application uses `rankings` as its document name. Ledger metadata is stored at `catan/rankings`; player and game records live in its `players` and `games` subcollections. Do not paste or manually construct the entire ledger in the Firebase console. Other documents in the collection are left alone. Vercel online room state also uses Firestore; the standard Node/Socket.IO transport still uses `CATAN_DATA_DIR/rooms.json`. Local pass-and-play remains in browser storage.

The same document is the root for private operational subcollections:

- `ownerSessions`: hashed owner-cookie identifiers, credential fingerprints, and expiry times.
- `ownerRateLimits`: transactional owner login attempt limits shared across server instances.
- `onlineRooms`: authoritative room state for Vercel's HTTP multiplayer transport, including hashed seat credentials.
- `onlineLimits`: shared creation and command limits for HTTP rooms.

These private documents are never returned by the public rankings API. Owner credentials are not saved to Firestore. Player/game records have no automatic expiry; transient documents contain `expiresAt` timestamps, and the application enforces their expiry regardless of optional Firestore TTL cleanup.

## Credentials and owner access

Firebase web configuration values such as `apiKey` do not authorize this backend. The server needs a Firebase Admin service identity. Use one of these options:

- On Google Cloud, assign a service account with Firestore access to the runtime and let Application Default Credentials use that identity.
- On your computer or another host, provide the Firebase Admin service-account JSON file with `GOOGLE_APPLICATION_CREDENTIALS`.
- If a host accepts environment secrets instead of files, store the complete downloaded JSON in `FIREBASE_SERVICE_ACCOUNT_JSON`.

For a key file, open **Project settings → Service accounts → Firebase Admin SDK** in the [Firebase project console](https://console.firebase.google.com/project/inventory-management-6626b/settings/serviceaccounts/adminsdk), generate a private key, and save the downloaded JSON outside this repository. Set the runtime variable to that file's absolute path. Use a dedicated service account with the access the app needs; a service account with Cloud Datastore User access can read and write Firestore. See [Firebase Admin setup](https://firebase.google.com/docs/admin/setup) and [Firestore IAM access control](https://cloud.google.com/firestore/native/docs/security/iam).

Keep the JSON, private key, and owner credentials in private files or your hosting provider's secret manager. Never put them in `VITE_` variables, frontend source, Git, or chat. The repository and Docker ignore common service-account filenames as an additional guard. The server checks that a supplied service-account key belongs to the configured Firebase project. Supply either the JSON secret or the file variable, not both.

Set both `RANKINGS_ADMIN_USERNAME` and `RANKINGS_ADMIN_PASSWORD` as private server environment variables. Choose your own username and a password of at least ten characters. The environment variables are the only owner identity: local password files and website setup are retired. If either variable is missing or invalid, public rankings remain readable when Firestore is configured, and editing stays disabled. Firebase Authentication setup is not needed for this app's owner login.

In Firestore mode, owner sessions and login rate limits are shared across instances. Cookies remain valid for twelve hours across cold starts and redeployments when credentials stay the same. Changing either variable and redeploying invalidates prior cookies on the new deployment; signing out revokes the session everywhere. See [owner access details](RANKINGS.md).

## Configure and run locally

Copy `.env.example` to the ignored `.env` file and set:

```dotenv
NODE_ENV=development
PORT=3001
CATAN_DATA_DIR=./server/data
RANKINGS_STORAGE=firestore
FIREBASE_PROJECT_ID=inventory-management-6626b
FIRESTORE_RANKINGS_DOCUMENT=catan/rankings
FIRESTORE_DATABASE_ID=(default)
GOOGLE_APPLICATION_CREDENTIALS=/absolute/private/path/firebase-service-account.json
RANKINGS_ADMIN_USERNAME="your-chosen-owner-name"
RANKINGS_ADMIN_PASSWORD="replace-with-your-private-password"
```

Use your own credential path, owner username, and password. With a named Firestore database, replace `(default)` with its actual database ID. Leave `FIRESTORE_EMULATOR_HOST` unset when connecting to the real database. Confirm the database already exists in the Firebase console and that the service account has access.

If you already have recorded games, import them using the next section before making new records in Firestore. Otherwise build and start:

```sh
npm run build
npm start
```

Stop the existing server on port 3001 before restarting it with the new configuration. Open [the rankings page](http://localhost:3001/#rankings), choose **Owner sign in**, and use the configured owner username and password. `npm start` and `npm run dev` load `.env` when it exists; variables already exported by your shell or hosting provider take precedence. Both owner variables must be set to enable editing; the site no longer offers first-time owner setup.

The storage choice is explicit: `RANKINGS_STORAGE=file` keeps the existing JSON implementation, and `firestore` uses the cloud database. A missing credential, invalid configuration, or unavailable database makes the rankings API report an error. It never quietly switches back to local files or overwrites your existing JSON ledger.

## Import your existing rankings

Keep a backup of `server/data/rankings.json`. The import command reads that file, validates the full ledger, and checks the configured Firestore destination. It previews the import by default. It does not change the source file and never imports owner credentials.

With the Firestore environment exported or configured in `.env`:

```sh
npm run rankings:import -- --file ./server/data/rankings.json
npm run rankings:import -- --file ./server/data/rankings.json --apply
```

Read the dry-run summary before using `--apply`. The import accepts only an empty destination and refuses to replace existing rankings. If someone records a game between preview and import, the final write detects that change and fails instead of overwriting it. After import, verify player totals and game details in the website and restart the server once to check persistence.

The importer supports up to 449 players and games combined in a single atomic import. A larger ledger is rejected before any records are written; it needs a separate migration strategy. Normal edits write only the changed records and retain optimistic revision checks.

## Deploy with Firestore

For **Vercel**, use the checked-in configuration and [Vercel deployment guide](VERCEL.md). Supply these values through the project's environment settings:

| Variable                        | Value                                                 |
| ------------------------------- | ----------------------------------------------------- |
| `RANKINGS_STORAGE`              | `firestore`                                           |
| `FIREBASE_PROJECT_ID`           | `inventory-management-6626b`                          |
| `FIRESTORE_RANKINGS_DOCUMENT`   | `catan/rankings`                                      |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Complete downloaded Firebase Admin JSON, kept private |
| `RANKINGS_ADMIN_USERNAME`       | Your chosen owner username                            |
| `RANKINGS_ADMIN_PASSWORD`       | Your chosen owner password, at least ten characters   |

`FIRESTORE_DATABASE_ID` is optional and defaults to `(default)`. Set the variables in each Vercel environment you use and redeploy after adding or changing them. The server uses the credentials at runtime; frontend assets never contain them. The Vercel build automatically selects HTTP rooms with `VITE_ONLINE_TRANSPORT=http`.

Vercel's API uses short HTTP requests and polls room updates about every two seconds while the page is visible. Rankings, owner sessions, rate limits, and online room state survive function replacement because Firestore is the shared source of truth. No persistent function filesystem or WebSocket server is required.

For **Render or another long-running Node host**, deploy the backend behind HTTPS and supply the same Firebase and owner variables. A secret file can alternatively be referenced with `GOOGLE_APPLICATION_CREDENTIALS`; supply only one service-account credential source. The Render Blueprint prompts for the JSON credential and both owner variables during initial creation. When updating an existing service, add secrets manually in its environment settings. See [Render's secret configuration](https://render.com/docs/blueprint-spec#prompting-for-secret-values).

The standard Node server's Socket.IO rooms remain tied to one process and use local room files. Keep one instance for that transport and attach persistent storage at `CATAN_DATA_DIR` if active rooms must survive a replacement. Firestore-backed rankings and owner sessions are independent of that disk. Production owner cookies require HTTPS.

Keep Firestore backups appropriate to your records. A persistent database protects against replacing the app deployment; an intentional deletion through the owner UI still deletes the record. Firestore use is subject to your project's quotas and billing plan. Rankings refreshes read ledger metadata and record documents; HTTP rooms read a room on each poll and periodically write presence updates.

## Restrict direct client access

All access for this app goes through the server. Browser clients do not need direct permission to read or write `catan/rankings` or any of its descendants, including owner sessions, rate limits, and online rooms. The Admin SDK uses IAM and bypasses Firestore Security Rules, so the app's server validates owner sessions and all edits. See [Firestore Security Rules structure](https://firebase.google.com/docs/firestore/security/rules-structure).

If your project's rules use version 2, a rule scoped to this document and its descendants can look like:

```text
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /catan/rankings/{document=**} {
      allow read, write: if false;
    }
    // Preserve the rules needed by the other applications in this project.
  }
}
```

Merge the scoped rule into your existing rules after reviewing them. Do not replace unrelated inventory-management rules with this sample. If another matching rule allows access, its allow still wins; a scoped `false` does not override a broader allow. Review overlapping rules, especially a blanket `/{document=**}` allow. The app does not deploy or modify your Firebase rules automatically.

## Emulator verification

Tests use a local Firestore emulator and a `demo-` project with no cloud resources. They do not use the real Firebase project, credentials, or rankings. The app refuses emulator configuration in production, a real project ID with an emulator host, and a demo project without an emulator host. Only loopback emulator addresses are accepted. See [Firebase emulator connection guidance](https://firebase.google.com/docs/emulator-suite/connect_firestore).

With the Firebase CLI and its required Java runtime installed, start the isolated emulator:

```sh
firebase emulators:start --only firestore --project demo-catan-rankings --config firebase.emulator.json
```

In another terminal, run:

```sh
FIRESTORE_EMULATOR_HOST=127.0.0.1:8181 npm run test:firestore
```

The smoke test covers owner-only API writes, concurrent revisions, persistence across separate server instances, shared cookies and logout, credential rotation, expired sessions, distributed login limits, invalid stored records, credential failures, and preserving unrelated documents. The default `npm test` also covers configuration validation. Remove emulator variables before running the real server.
