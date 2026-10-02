# Firebase rankings on Vercel

The browser reads public rankings through the Firebase Web SDK. Owner sign-in and edits go through the same-origin Catan API, which uses the existing Firebase Admin service-account credential. Your owner username and password stay in server environment variables. Firebase Authentication, an owner UID, and Workload Identity Federation are not required.

## Environment variables

In Vercel's **Production** environment, add the standard Firebase Console web config as **Config** values:

| Variable                            | Firebase field                            |
| ----------------------------------- | ----------------------------------------- |
| `VITE_FIREBASE_API_KEY`             | `apiKey`                                  |
| `VITE_FIREBASE_AUTH_DOMAIN`         | `authDomain`                              |
| `VITE_FIREBASE_PROJECT_ID`          | `projectId`: `inventory-management-6626b` |
| `VITE_FIREBASE_APP_ID`              | `appId`                                   |
| `VITE_FIREBASE_STORAGE_BUCKET`      | `storageBucket`, optional                 |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | `messagingSenderId`, optional             |
| `VITE_FIREBASE_MEASUREMENT_ID`      | `measurementId`, optional                 |

Keep the `VITE_` prefix. These identifiers are compiled into the browser; the Firebase API key is part of the public web config. Use plain values without surrounding quotes. The storage variable ends in `STORAGE_BUCKET`, not `STORAGE_ID`. [Vite environment variables](https://vite.dev/guide/env-and-mode), [Firebase API keys](https://firebase.google.com/docs/projects/api-keys).

Set these server variables separately:

| Variable                        | Vercel type | Value                                                                 |
| ------------------------------- | ----------- | --------------------------------------------------------------------- |
| `RANKINGS_ADMIN_USERNAME`       | Secret      | Your chosen owner username                                            |
| `RANKINGS_ADMIN_PASSWORD`       | Secret      | Your chosen non-empty password, up to 1,024 UTF-8 bytes               |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Secret      | The complete contents of your existing Firebase Admin JSON credential |
| `RANKINGS_STORAGE`              | Config      | `firestore`                                                           |
| `FIREBASE_AUTH_MODE`            | Config      | `admin`                                                               |
| `FIREBASE_PROJECT_ID`           | Config      | `inventory-management-6626b`                                          |
| `FIRESTORE_RANKINGS_DOCUMENT`   | Config      | `catan/rankings`                                                      |

Paste the credential's JSON contents into its Secret value, not its filename. Keep its `private_key` JSON escapes intact; do not add another outer layer of quotes. `FIREBASE_PROJECT_ID` is required and must match the credential's `project_id`. `FIREBASE_AUTH_MODE=admin` avoids selecting an older connection mode if previous `FIREBASE_API_KEY` or `FIREBASE_CONFIG` variables remain configured.

Never use `VITE_` for the owner password or service-account JSON, and never commit either to Git. The existing credential is used only by the server. No new Firebase account or key is needed. [Firebase Admin setup](https://firebase.google.com/docs/admin/setup).

**Redeploy after saving variables.** Public config is read during the build, and server variables belong to each deployment. Existing deployments do not acquire changed values automatically. [Vercel environment variables](https://vercel.com/docs/environment-variables).

## Firestore rules and owner sign-in

Merge the three exact public-read matches from [firestore.rules.example](../firestore.rules.example) into the existing rules, preserving unrelated inventory/application rules:

```text
match /catan/rankings { allow get: if true; }
match /catan/rankings/players/{playerId} { allow get, list: if true; }
match /catan/rankings/games/{gameId} { allow get, list: if true; }
```

Do not grant direct browser writes or make the entire `catan` subtree readable. Other subcollections hold private room state, owner sessions, and rate limits. A broader matching allow overrides the protection from having no allow here, so inspect overlapping rules when merging. Firebase Admin writes use the server's Google IAM credential and do not depend on client rules. [Firestore rules structure](https://firebase.google.com/docs/firestore/security/rules-structure), [server access](https://firebase.google.com/docs/firestore/security/get-started).

Open **Rankings → Owner sign in** and enter the username/password from `RANKINGS_ADMIN_USERNAME` and `RANKINGS_ADMIN_PASSWORD`. The API verifies the credentials and sets a twelve-hour HTTP-only session cookie. **Lock editing** signs out and revokes it. Changing the owner environment values and redeploying invalidates earlier sessions on the new deployment.

There is no Firebase Authentication provider, Firebase owner account, authorized-domain step, UID placeholder, or `access/owner` document to configure. Only the server may edit records. Both the client and server validate game data; the server commits edits atomically and rejects stale revisions.

## Persistence and multiplayer

Existing records stay under `catan/rankings`, with `players` and `games` subcollections. No migration is required. Firestore also holds private owner sessions, login limits, and Vercel online rooms; those records are not included in the public-read rules.

The same server credential supports Vercel multiplayer. The server remains responsible for legal actions and private hands. Local Node hosting continues using Socket.IO with room files. The public Firebase config alone grants no server credentials.

Public ranking reads use Firestore directly. Owner access checks use `/api/rankings/access`; login, save and logout use the corresponding `/api/rankings` routes. A service outage never silently switches a cloud ledger to local files. See [persistence details](FIRESTORE.md).

## Verification

After redeploying, open `/api/health` and `/#rankings` while signed out. Public records should load. Sign in with the environment username/password, record a game, reload and check that it remains. A separate signed-out browser can read the record but cannot edit. Sign out and confirm editing disappears.

If public reads fail, check the public build variables and published read-only rules. If owner login fails, check the two owner Secret values. If saving or online rooms fail, check the Admin JSON Secret, matching project, `FIREBASE_AUTH_MODE=admin`, storage mode and document path.

Tests use isolated demo data and a local Firestore emulator. They never publish production rules or use production credentials. The [emulator guide](FIRESTORE.md#emulator-verification) describes the public-read and HTTP-owner checks.
