# Vercel multiplayer backend

Online games and owner ranking edits share the server's Firebase Admin service-account connection. Follow [the Vercel setup guide](VERCEL.md) for the active configuration. Public rankings are read through the browser Web SDK; private game state and owner writes remain on the server.

The multiplayer API validates moves, stores complete private room state, and sends each player only the information they may see. Its server identity must be authorized to Firestore independently of browser users. Keep the existing server settings in place when using online rooms.

## Service-account configuration

Set `FIREBASE_AUTH_MODE=admin`, `FIREBASE_PROJECT_ID=inventory-management-6626b`, `FIRESTORE_RANKINGS_DOCUMENT=catan/rankings`, and `RANKINGS_STORAGE=firestore`. Store the existing JSON credential in the server-only `FIREBASE_SERVICE_ACCOUNT_JSON` Secret. This connection supports both multiplayer and the owner API. The `onlineRooms`, `onlineLimits`, `ownerSessions`, and `ownerRateLimits` subcollections stay private.

## Optional keyless alternative

The server accepts the existing `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`, and `FIREBASE_APP_ID` values, with the optional Console fields. These are distinct from the `VITE_FIREBASE_*` browser rankings fields. `FIREBASE_AUTH_MODE=web` selects the keyless deployment identity; this is also selected when the server web config is present. The default root is `catan/rankings`, whose `onlineRooms` and `onlineLimits` descendants are private.

No Firebase backend account or downloaded key is required in this server mode. Vercel provides an OIDC token, which is exchanged for a short-lived Google access token. Google Cloud must trust this particular production deployment. Public web config alone does not authorize that exchange.

### One-time permissions for the keyless alternative

Vercel OIDC is already enabled with the team issuer mode. The reviewable helper targets the existing `inventory-management-6626b` project and the exact Catan Vercel team, project, and production environment.

Use [Google Cloud Shell](https://shell.cloud.google.com/), upload `scripts/setup-vercel-firestore.mjs` using **More → Upload → File**, then review the plan:

```sh
node ~/setup-vercel-firestore.mjs
```

The helper prints proposed commands without modifying cloud resources. To apply the reviewed plan:

```sh
node ~/setup-vercel-firestore.mjs --apply
```

It creates the `catan-vercel` workload identity pool, `vercel` provider, and keyless `catan-api` service identity if missing. Exact team/project IDs, slugs, subject, and production environment are required. Existing mismatched resources cause an error rather than an update. The helper never modifies data, publishes Firestore Rules, creates a database/key, or removes existing IAM bindings.

The custom data role grants six transaction/document permissions conditioned on the existing default database. **Firestore IAM cannot restrict this account to the Catan collection**; its data permissions cover other collections in that database too. A separate database and deliberate migration would be needed for database-level isolation. This permission scope is printed before apply.

After a successful setup, wait for IAM propagation and redeploy. Preview deployments and laptops are deliberately excluded from this production trust. [Vercel OIDC setup](https://vercel.com/docs/oidc/gcp), [Firestore IAM](https://cloud.google.com/firestore/native/docs/security/iam).

## Rules and persistence

Keep the private room/session/limit collections denied in client Firestore Rules. The scoped browser rankings rules expose only ledger metadata, players, and games. The server uses IAM authorization, so client denies do not block it. Browser clients must not receive direct access to private room documents.

Rooms expire after 72 hours of inactivity; API code enforces this without requiring TTL cleanup. Rankings never expire with rooms. The owner API stores its shared sessions and login limits in private Firestore subcollections.

Verify `/api/online/health`, create a room, and join from another browser profile. The status endpoint alone does not prove successful Firestore reads/writes. An authentication failure leaves online games unavailable without falling back to local files. Local pass-and-play and separately configured browser rankings remain available.

Local Node/Render deployments can retain their existing Admin connection and Socket.IO room storage. Server credentials must never be exposed through `VITE_` fields. Both local and Vercel owner access use the `/api/rankings` API with environment-configured username/password credentials.
