# Store Catan rankings in Firestore

The rankings API can store its ledger in Cloud Firestore. The Node server uses Firebase Admin; the browser continues to read the public rankings API, and only the owner password authorizes changes. Player names, recorded dates, notes, and VP breakdowns remain editable through the existing page.

The configured destination for this project is:

| Setting             | Value                        |
| ------------------- | ---------------------------- |
| Firebase project ID | `inventory-management-6626b` |
| Firestore database  | `(default)`                  |
| Collection          | `catan`                      |
| Rankings document   | `catan/rankings`             |

`catan` is a collection, so the application uses `rankings` as its document name. Ledger metadata is stored at `catan/rankings`; player and game records live in its `players` and `games` subcollections. Do not paste or manually construct the entire ledger in the Firebase console. Other documents in the collection are left alone. This integration changes rankings storage; online room state still uses `CATAN_DATA_DIR/rooms.json`, and local pass-and-play remains in browser storage.

## Credentials and owner access

Firebase web configuration values such as `apiKey` do not authorize this backend. The server needs a Firebase Admin service identity. Use one of these options:

- On Google Cloud, assign a service account with Firestore access to the runtime and let Application Default Credentials use that identity.
- On your computer or another host, provide the Firebase Admin service-account JSON file with `GOOGLE_APPLICATION_CREDENTIALS`.
- If a host accepts environment secrets instead of files, store the complete downloaded JSON in `FIREBASE_SERVICE_ACCOUNT_JSON`.

For a key file, open **Project settings → Service accounts → Firebase Admin SDK** in the [Firebase project console](https://console.firebase.google.com/project/inventory-management-6626b/settings/serviceaccounts/adminsdk), generate a private key, and save the downloaded JSON outside this repository. Set the runtime variable to that file's absolute path. Use a dedicated service account with the access the app needs; a service account with Cloud Datastore User access can read and write Firestore. See [Firebase Admin setup](https://firebase.google.com/docs/admin/setup) and [Firestore IAM access control](https://cloud.google.com/firestore/native/docs/security/iam).

Keep the JSON, private key, and owner password in private files or your hosting provider's secret manager. Never put them in `VITE_` variables, frontend source, Git, or chat. The repository and Docker ignore common service-account filenames as an additional guard. The server checks that a supplied service-account key belongs to the configured Firebase project. Supply either the JSON secret or the file variable, not both.

Set `RANKINGS_ADMIN_PASSWORD` to a unique password of at least ten characters for deployment. It is required when Firestore is selected in production, so owner access does not depend on a password file in an ephemeral deployment. Existing local owner credentials do not override that environment secret. Local development can retain its current owner password file or create owner access through the loopback-only setup screen. Firebase Authentication setup is not needed for this app's current password-based owner login.

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
RANKINGS_ADMIN_PASSWORD="replace-with-your-private-password"
```

Use your own credential path and password. With a named Firestore database, replace `(default)` with its actual database ID. Leave `FIRESTORE_EMULATOR_HOST` unset when connecting to the real database. Confirm the database already exists in the Firebase console and that the service account has access.

If you already have recorded games, import them using the next section before making new records in Firestore. Otherwise build and start:

```sh
npm run build
npm start
```

Stop the existing server on port 3001 before restarting it with the new configuration. Open [the rankings page](http://localhost:3001/#rankings), choose **Owner sign in**, and use the environment password. `npm start` and `npm run dev` load `.env` when it exists; variables already exported by your shell or hosting provider take precedence. If you omit the password variable locally, use the existing owner password or the first-time **Set up owner access** option.

The storage choice is explicit: `RANKINGS_STORAGE=file` keeps the existing JSON implementation, and `firestore` uses the cloud database. A missing credential, invalid configuration, or unavailable database makes the rankings API report an error. It never quietly switches back to local files or overwrites your existing JSON ledger.

## Import your existing rankings

Keep a backup of `server/data/rankings.json`. The import command reads that file, validates the full ledger, and checks the configured Firestore destination. It previews the import by default. It does not change the source file and never imports the local owner password file.

With the Firestore environment exported or configured in `.env`:

```sh
npm run rankings:import -- --file ./server/data/rankings.json
npm run rankings:import -- --file ./server/data/rankings.json --apply
```

Read the dry-run summary before using `--apply`. The import accepts only an empty destination and refuses to replace existing rankings. If someone records a game between preview and import, the final write detects that change and fails instead of overwriting it. After import, verify player totals and game details in the website and restart the server once to check persistence.

The importer supports up to 449 players and games combined in a single atomic import. A larger ledger is rejected before any records are written; it needs a separate migration strategy. Normal edits write only the changed records and retain optimistic revision checks.

## Deploy with Firestore

Deploy the Node app, including its backend, behind HTTPS. In the host's environment settings, supply `RANKINGS_STORAGE=firestore`, the project and document values above, a private `RANKINGS_ADMIN_PASSWORD`, and one credential source. On Render, a secret file can be mounted and referenced with `GOOGLE_APPLICATION_CREDENTIALS`; the JSON environment-secret option is also supported. Inject credentials at runtime, never while building frontend assets or the Docker image.

The included Render Blueprint selects this Firestore project and prompts for the JSON credential and owner password during initial creation. When updating an existing Render service, add new secrets manually in its environment settings; Blueprint secret prompts only appear during creation. See [Render's secret configuration](https://render.com/docs/blueprint-spec#prompting-for-secret-values).

Once enabled, rankings are independent of the app's local disk and survive replacing or redeploying the server. Keep one app instance: room state, sign-in sessions, and login rate limits still live on a single server. Firestore protects rankings against concurrent saves, but does not make the entire multiplayer app ready for multiple replicas. Production owner cookies require HTTPS. A persistent `CATAN_DATA_DIR` is still needed if you want active online rooms to survive a deployment.

Keep Firestore backups appropriate to your game records. A persistent database protects against replacing the app container; an intentional deletion through the owner UI still deletes that record. Firestore use is subject to your project's quotas and billing plan; each rankings refresh reads the ledger and its record documents.

## Restrict direct client access

All access for this feature goes through the server. Browser clients do not need direct permission to read or write `catan/rankings` or its child records. The Admin SDK uses IAM and bypasses Firestore Security Rules, so the app's server validates owner sessions and all edits. See [Firestore Security Rules structure](https://firebase.google.com/docs/firestore/security/rules-structure).

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

The smoke test covers owner-only API writes, concurrent revisions, persistence across separate server instances, invalid stored records, credential failures, and preserving unrelated documents. The default `npm test` also covers configuration validation. Remove emulator variables before running the real server.
