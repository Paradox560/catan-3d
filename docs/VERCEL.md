# Deploy Catan with Firebase web config

Production: [catan-3d-ebon.vercel.app](https://catan-3d-ebon.vercel.app). Repository: [Paradox560/catan-3d](https://github.com/Paradox560/catan-3d). Configure values in [Vercel environment settings](https://vercel.com/pranavs-projects-e233eba1/catan-3d/settings/environment-variables).

Web mode uses the configuration from **Firebase Console → Project settings → Your apps → Web**. The backend signs in to Firebase Authentication and uses its ID token with Firestore's REST API. No service-account JSON or private key is required. Existing rankings records, owner login, and multiplayer behavior are preserved.

The web config identifies the app; a dedicated Firebase Authentication account authorizes the backend. Its credentials and tokens stay on the server. Visitors use the Catan API, which enforces owner access, move legality, and private game hands. See [Firebase web config](https://firebase.google.com/docs/web/learn-more#config-object) and [Firestore REST authentication](https://firebase.google.com/docs/firestore/use-rest-api#authentication_and_authorization).

## One-time Firebase setup

1. In `inventory-management-6626b`, enable **Authentication → Sign-in method → Email/Password**.
2. Under **Authentication → Users**, create a dedicated backend user with an email and strong password. Copy its **UID**. Use credentials separate from the website owner login.
3. In **Firestore Database → Rules**, merge this match into the existing `match /databases/{database}/documents` block. Use rules version 2 and replace the placeholder with that user's exact UID:

```text
match /catan/rankings/{document=**} {
  allow read, write: if request.auth != null
    && request.auth.uid == 'REPLACE_WITH_BACKEND_UID';
}
```

This grants the backend account access to the ledger and its children. Preserve other applications' rules. Remove broader rules that grant other users access to this subtree: matching allows are additive. The [complete rules example](../firestore.rules.example) is a template, not a replacement for unrelated rules. Publish your reviewed rules in Firebase Console.

The app does not create this account or publish rules automatically. It verifies the configured backend UID and token project before accessing Firestore. Anonymous clients and other Firebase users should have no direct access to these records. Everyone can still read rankings through the Catan API.

## Vercel environment variables

Set these for **Production**, then redeploy:

| Variable                      | Value                                                              |
| ----------------------------- | ------------------------------------------------------------------ |
| `RANKINGS_STORAGE`            | `firestore`                                                        |
| `FIREBASE_AUTH_MODE`          | `web`                                                              |
| `FIREBASE_API_KEY`            | Web config's `apiKey`                                              |
| `FIREBASE_AUTH_DOMAIN`        | Web config's `authDomain`                                          |
| `FIREBASE_PROJECT_ID`         | `inventory-management-6626b`                                       |
| `FIREBASE_APP_ID`             | Web config's `appId`                                               |
| `FIREBASE_BACKEND_EMAIL`      | Dedicated Firebase Authentication user's email                     |
| `FIREBASE_BACKEND_PASSWORD`   | That user's password; keep sensitive                               |
| `FIREBASE_BACKEND_UID`        | That user's exact UID                                              |
| `FIRESTORE_RANKINGS_DOCUMENT` | `catan/rankings`                                                   |
| `RANKINGS_ADMIN_USERNAME`     | Your chosen website owner username                                 |
| `RANKINGS_ADMIN_PASSWORD`     | Your chosen owner password, at least 10 characters; keep sensitive |

Optional config fields map to `FIREBASE_STORAGE_BUCKET`, `FIREBASE_MESSAGING_SENDER_ID`, `FIREBASE_MEASUREMENT_ID`, and `FIREBASE_DATABASE_URL`. `FIRESTORE_DATABASE_ID` defaults to `(default)`.

Alternatively, `FIREBASE_CONFIG` may contain the complete **web config** as valid JSON, replacing the individual public Firebase fields. Exclude JavaScript declarations, comments, and trailing semicolons. Backend account, owner settings, and document path still need separate variables. Do not mix JSON and individual public config sources.

Remove `FIREBASE_SERVICE_ACCOUNT_JSON` and `GOOGLE_APPLICATION_CREDENTIALS` in web mode. Never use `VITE_` prefixes for backend secrets. Leave emulator host variables unset on Vercel. The Firebase API key must permit server-side Firebase Authentication requests; browser-referrer-only restrictions prevent backend sign-in.

No `PORT`, persistent disk, or extra session secret is required. `vercel.json` already selects HTTP multiplayer. **Redeploy after changing variables**: existing deployments retain their previous environment. See [Vercel environment variables](https://vercel.com/docs/environment-variables).

For isolated Preview deployments, use a separate document path and matching rules. Preview and production URLs have separate cookies and room seat tokens.

## Persistence and operation

The frontend is served from `dist/`; `api/index.ts` mounts the Express APIs as a Vercel function. The backend caches Firebase sign-in per connection and obtains refreshed ID tokens through the SDK. Firestore transactions still protect coherent ledger reads, concurrent saves, online moves, and rate limits.

All state remains under the configured root:

```text
catan/rankings
  players/{playerId}
  games/{gameId}
  ownerSessions/{hashedToken}
  ownerRateLimits/{hashedLimitKey}
  onlineRooms/{roomCode}
  onlineLimits/{hashedLimitKey}
```

Owner sessions last twelve hours and work across instances. Sign-out revokes them; changing owner environment values and redeploying invalidates old cookies on the new deployment. The separate Firebase backend identity is used even when no owner is signed in, so public rankings and games remain available.

Game tabs poll about every two seconds while visible and fifteen seconds while hidden. Presence renews about every thirty seconds, seats disconnect after seventy-five seconds without renewal, and rooms expire after seventy-two hours without activity. Firebase usage is subject to project quotas. Optional `expiresAt` TTL cleanup can remove expired transient documents; expiration is enforced without it.

Local pass-and-play works without Firebase. The standard Node/Docker server still uses Socket.IO and local room saves; its rankings support either Firebase authentication mode. Legacy Admin SDK setups can select `FIREBASE_AUTH_MODE=admin`. Web-mode authentication errors never fall back to Admin credentials or local files.

Rankings currently exchange the complete ledger. Large archives must remain below [Vercel's payload limits](https://vercel.com/docs/functions/limitations); pagination is needed before reaching the 4.5 MB request/response ceiling.

Deploy from the linked repository:

```sh
cd ~/Desktop/catan-3d
npx vercel@latest --prod
```

## Verification

After configuring Firebase and redeploying, open `/api/health`, load `/#rankings`, sign in through **Owner sign in**, and create/join an online table in separate browser profiles. Health confirms the function is running; reading rankings checks actual database access. Cloud features report a configuration error until the account, rules, and variables are ready.

For isolated web-config verification:

```sh
firebase emulators:start --only auth,firestore --project demo-catan-web --config firebase.web.emulator.json
FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 FIRESTORE_EMULATOR_HOST=127.0.0.1:8181 npm run test:firebase-web
```

These tests allow only local emulators and demo projects. The UID in `tests/firestore.web.rules` is a test fixture and must not be used in production. Legacy Admin-mode emulator suites use the separate `firebase.emulator.json` configuration.
