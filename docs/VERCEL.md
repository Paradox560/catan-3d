# Deploy Catan with Firebase web config

Production: [catan-3d-ebon.vercel.app](https://catan-3d-ebon.vercel.app). Repository: [Paradox560/catan-3d](https://github.com/Paradox560/catan-3d). Configure values in [Vercel environment settings](https://vercel.com/pranavs-projects-e233eba1/catan-3d/settings/environment-variables).

Supply the standard Firebase web config and your website owner username/password. The deployed backend uses **Vercel OIDC and Google Workload Identity Federation** for short-lived database credentials. There is no Firebase backend email/password/UID and no downloaded service-account key.

**One Google Cloud trust setup is still required.** Public Firebase config identifies the app; it cannot grant a server permission to private records. The setup below authorizes this specific Vercel production project automatically, without another credential value to copy into Vercel. See [Vercel OIDC](https://vercel.com/docs/oidc) and [Google Workload Identity Federation](https://cloud.google.com/iam/docs/workload-identity-federation).

## Vercel environment variables

For **Production**, enter the fields from **Firebase Console → Project settings → Your apps → Web config**:

| Variable                       | Firebase config field                     |
| ------------------------------ | ----------------------------------------- |
| `FIREBASE_API_KEY`             | `apiKey`                                  |
| `FIREBASE_AUTH_DOMAIN`         | `authDomain`                              |
| `FIREBASE_PROJECT_ID`          | `projectId`: `inventory-management-6626b` |
| `FIREBASE_APP_ID`              | `appId`                                   |
| `FIREBASE_STORAGE_BUCKET`      | `storageBucket`, optional                 |
| `FIREBASE_MESSAGING_SENDER_ID` | `messagingSenderId`, optional             |
| `FIREBASE_MEASUREMENT_ID`      | `measurementId`, optional                 |

`FIREBASE_DATABASE_URL` accepts the optional `databaseURL` field if your config includes it. The project number is derived from `appId`; an optional `messagingSenderId` must agree with it. There is no separate Google project-number variable.

Alternatively, set only `FIREBASE_CONFIG` to the complete web config as valid JSON. It replaces the individual public fields. Do not include JavaScript declarations, comments, or trailing semicolons, and do not mix JSON and individual config sources.

Keep the two website owner settings:

| Variable                  | Value                                                 |
| ------------------------- | ----------------------------------------------------- |
| `RANKINGS_ADMIN_USERNAME` | Your chosen website owner username                    |
| `RANKINGS_ADMIN_PASSWORD` | Your chosen private password, at least ten characters |

The owner password stays on the server. Do not prefix it with `VITE_`. Remove the obsolete `FIREBASE_BACKEND_EMAIL`, `FIREBASE_BACKEND_PASSWORD`, and `FIREBASE_BACKEND_UID` values if they were added. Keyless web-config mode does not use `FIREBASE_SERVICE_ACCOUNT_JSON` or `GOOGLE_APPLICATION_CREDENTIALS` either.

On Vercel, Firestore storage is the default, web config selects web authentication mode, and the document path defaults to `catan/rankings`. `RANKINGS_STORAGE`, `FIREBASE_AUTH_MODE`, and `FIRESTORE_RANKINGS_DOCUMENT` remain optional explicit overrides. `FIRESTORE_DATABASE_ID` defaults to `(default)`; a different database needs a corresponding IAM grant and deliberate data migration.

**Redeploy after changing variables.** Existing deployments retain their original environment. No `PORT`, persistent disk, manually supplied OIDC token, pool/provider identifier, or service-account email variable is needed. See [Vercel environment variables](https://vercel.com/docs/environment-variables).

## One-time Google Cloud trust setup

Use [Google Cloud Shell](https://shell.cloud.google.com/) while signed in to an account that can manage IAM in `inventory-management-6626b`. The Google Cloud CLI is already available there. The helper's target project and verified Vercel identifiers are built in; you do not need to supply extra identifiers or secrets.

Download or locate `scripts/setup-vercel-firestore.mjs` from this repository. In Cloud Shell, choose **More → Upload → File**, upload that single file, then run it from your home directory. The helper has no package dependencies:

```sh
node ~/setup-vercel-firestore.mjs
```

Alternatively, if Cloud Shell already has access to your private GitHub repository, clone it and run `node scripts/setup-vercel-firestore.mjs` from the repository directory. A private repository requires GitHub authentication; uploading the helper avoids that extra setup.

The default command reads the existing project, database, trust resources, service account, custom role, and bindings. It prints the proposed commands **without changing cloud resources**. If required Google APIs are disabled, it first shows that prerequisite; apply enables them and then inspects the trust resources before making IAM changes.

After reviewing the plan and permission scope below, explicitly apply it:

```sh
node ~/setup-vercel-firestore.mjs --apply
```

The helper creates only missing resources and adds missing bindings. Repeating it with matching configuration makes no changes. It refuses to adopt a pool, provider, account, role, private key, or binding that differs from its reviewed expectations. It never changes Firestore records or rules, creates a database or private key, removes an existing binding, or updates an existing provider. A mismatch requires manual review.

The target identity is fixed to:

| Setting                           | Value                                                          |
| --------------------------------- | -------------------------------------------------------------- |
| Vercel team                       | `pranavs-projects-e233eba1`                                    |
| Stable team ID                    | `team_6tgOPsjhyKG1HjzT5IAPmuht`                                |
| Vercel project                    | `catan-3d`                                                     |
| Stable project ID                 | `prj_hacrrJpcDQ3DbuTAGh3bXWLIoYid`                             |
| Environment                       | `production` only                                              |
| Workload identity pool / provider | `catan-vercel` / `vercel`                                      |
| Keyless service identity          | `catan-api@inventory-management-6626b.iam.gserviceaccount.com` |

The Vercel project already has OIDC enabled with the team issuer. The provider trusts `https://oidc.vercel.com/pranavs-projects-e233eba1`, maps the subject claim, and checks the exact stable IDs, names, production environment, and subject. The runtime requests the provider's canonical Google audience. Preview deployments and local development are not granted this production identity. [Vercel token claims](https://vercel.com/docs/oidc/reference), [Google OIDC provider configuration](https://cloud.google.com/sdk/gcloud/reference/iam/workload-identity-pools/providers/create-oidc).

The helper grants only the Firestore transaction and document create/read/list/update/delete permissions used by Catan. A project IAM condition restricts them to the existing `(default)` database; no database, index, export, or IAM administration permissions are granted to the runtime account. [Firestore permissions](https://cloud.google.com/firestore/native/docs/security/iam), [database IAM conditions](https://cloud.google.com/firestore/docs/manage-databases#configure_per-database_access_permissions).

**Permission scope:** Firestore IAM cannot limit this identity to one collection. Within `(default)`, those data permissions also cover other collections, including inventory data if stored there. Catan's code operates under `catan/rankings`, but that is an application boundary. A separate Firestore database and deliberate migration are needed for database-level isolation. The helper leaves all existing data where it is and prints this scope before any apply operation.

Wait for IAM changes to propagate, then redeploy production. The setup requires Google project administration permissions; the deployed app receives only the data permissions above. Renaming or moving the Vercel project requires reviewing the trust policy instead of silently accepting a new identity.

## Firestore client rules

Visitors access the Catan API. Their browsers do not need direct database access. Merge the scoped deny from [firestore.rules.example](../firestore.rules.example) into the existing Firestore Rules, preserving unrelated application matches:

```text
match /catan/rankings/{document=**} {
  allow read, write: if false;
}
```

Use rules version 2 and ensure that a broader matching rule does not grant client access to this subtree. Rules are additive; a deny cannot cancel another allow. The keyless server identity is authorized by Google IAM and bypasses client Security Rules, so this deny does not block the backend. No Firebase Authentication Email/Password provider or backend user is needed. The helper does not publish rules. [Firestore rules structure](https://firebase.google.com/docs/firestore/security/rules-structure).

## Persistence and operation

`api/index.ts` mounts the APIs as a Vercel function. Vercel supplies its workload token; the backend exchanges it for short-lived Google credentials to access Firestore. No refresh token or private key is saved. Firestore transactions still protect coherent ledger reads, concurrent saves, legal online moves, and shared rate limits.

State stays under the same root:

```text
catan/rankings
  players/{playerId}
  games/{gameId}
  ownerSessions/{hashedToken}
  ownerRateLimits/{hashedLimitKey}
  onlineRooms/{roomCode}
  onlineLimits/{hashedLimitKey}
```

Owner sessions last twelve hours and work across instances. Signing out revokes them; changing owner variables and redeploying invalidates previous sessions on the new deployment. Public rankings and online rooms use the platform identity even when the owner is signed out.

Game tabs poll every two seconds while visible and fifteen seconds while hidden. Presence renews about every thirty seconds, seats disconnect after seventy-five seconds without renewal, and rooms expire after seventy-two hours without activity. Optional `expiresAt` TTL cleanup removes transient records; the app enforces expiry regardless. Rankings never expire with rooms.

Local pass-and-play needs no Firebase. Local Node/Docker uses Socket.IO room files; local Firestore development may keep an explicitly configured legacy Admin identity. The production OIDC grant intentionally does not authorize a laptop, preview deployment, or another hosting provider.

Rankings currently exchange the complete ledger. Large archives need pagination before reaching [Vercel's 4.5 MB payload ceiling](https://vercel.com/docs/functions/limitations).

## Verification

Redeploy with your public config and owner values, then open `/api/health` and `/#rankings`. Health verifies the function; the rankings page verifies actual Firestore access. Sign in through **Owner sign in** and test an online table in separate browser profiles. A missing trust grant returns a cloud configuration error without falling back to local files or changing records.

To check the setup helper without touching Google Cloud:

```sh
node --test scripts/setup-vercel-firestore.test.mjs
```

Its tests use a fake Google CLI runner to verify review-only behavior, idempotence, and refusal of broadened or mismatched trust. Runtime unit tests mock token exchange; Firestore emulator tests verify storage transactions. These checks do not prove that a real IAM grant has been installed. Complete the one-time setup before expecting production database access.
