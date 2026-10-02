# Firebase rankings on Vercel

The rankings page uses the Firebase Web SDK directly: `initializeApp`, `getFirestore`, and Firebase Authentication. No Vercel-to-Google IAM setup, backend Firebase account, service-account JSON, or server owner password is required for rankings.

## Environment variables

Copy the values from **Firebase Console → Project settings → Your apps → Web config** into Vercel's **Production** environment:

| Variable                            | Config field                               | Required |
| ----------------------------------- | ------------------------------------------ | -------- |
| `VITE_FIREBASE_API_KEY`             | `apiKey`                                   | Yes      |
| `VITE_FIREBASE_AUTH_DOMAIN`         | `authDomain`                               | Yes      |
| `VITE_FIREBASE_PROJECT_ID`          | `projectId` (`inventory-management-6626b`) | Yes      |
| `VITE_FIREBASE_APP_ID`              | `appId`                                    | Yes      |
| `VITE_FIREBASE_STORAGE_BUCKET`      | `storageBucket`                            | Optional |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | `messagingSenderId`                        | Optional |
| `VITE_FIREBASE_MEASUREMENT_ID`      | `measurementId`                            | Optional |

Enter plain values without surrounding quotes. The storage field ends in **STORAGE_BUCKET**, not `STORAGE_ID`. This is a Vite app, so `NEXT_PUBLIC_*` variables do not apply. `VITE_*` values are included in the browser bundle; they contain public Firebase identifiers only. Never put an owner password or service-account key there. [Vite environment variables](https://vite.dev/guide/env-and-mode), [Firebase web setup](https://firebase.google.com/docs/web/setup).

**Redeploy after saving the variables.** They are read during the build. Do not copy the entire local `.env.example` into Vercel; use the seven public fields above. The `FIREBASE_BACKEND_*` and `RANKINGS_ADMIN_*` variables are not used by the new rankings page.

## Owner sign-in and rules

1. In Firebase Authentication, enable **Email/Password**.
2. Create your owner user under **Authentication → Users**, then copy that user's UID. This is your own login, not a separate backend account.
3. In [firestore.rules.example](../firestore.rules.example), replace `REPLACE_WITH_OWNER_UID` with that UID. Merge the Catan matches into your existing Firestore rules and publish them. Preserve rules for your inventory app and other collections. Remove any broader allow that exposes private Catan subcollections; Firestore rules combine matching allows.
4. Add `catan-3d-ebon.vercel.app` to **Authentication → Settings → Authorized domains**. Add a custom website domain if you use one.
5. Open the site's **Rankings → Owner sign in**, then enter the Firebase user's email and password. They are typed into the login form, not stored in Vercel environment variables.

The rules allow public reads of the rankings metadata and the `players` and `games` collections. Only the configured owner may write rankings. Rooms, private hands, owner sessions, rate limits, and unrelated collections are never made public by these matches. The app offers sign-in only; it has no public owner-registration flow. [Email/password sign-in](https://firebase.google.com/docs/auth/web/password-auth), [Firestore Security Rules](https://firebase.google.com/docs/firestore/security/get-started).

A read of `catan/rankings/access/owner` checks the owner's permission using those rules. The document does not need to exist or contain data. This avoids a separate owner-UID environment variable. The rules remain the source of authorization even if someone modifies browser code.

The browser keeps sign-in for the current tab session, including refreshes; **Lock editing** signs out. Existing recorded games stay in `catan/rankings` and its player/game subcollections, so no data migration is required. Saves use transactions and reject stale revisions instead of overwriting another tab's edits. An offline or failed save is not reported as confirmed.

The old Vercel `/api/rankings` route returns 410. Its previous environment-based credentials and cookies can no longer edit the hosted ledger. The legacy API remains available only for existing local Node installations built with `VITE_RANKINGS_TRANSPORT=http`.

## Multiplayer

Online games continue using their existing trusted backend to validate moves and protect private hands. Browser rankings do not depend on that backend. Leave its existing server-only settings in place if using online games; see [multiplayer backend configuration](MULTIPLAYER_BACKEND.md). The seven browser variables above are sufficient for rankings after Firebase Auth and rules are configured; they do not independently authorize the multiplayer server.

## Verification

After redeploying, open `/#rankings` in a signed-out browser. The ledger should load without a request to `/api/rankings`. Sign in with the owner user, record a game, refresh, and verify the game remains. Another signed-out browser can read but cannot edit.

If Firebase reports missing permissions, check the published rules and exact owner UID. If sign-in fails, check that Email/Password is enabled and use the Firebase account's actual email/password. Missing configuration means the corresponding `VITE_FIREBASE_*` value was absent from the build; update Production and redeploy.

Tests use isolated demo Firebase emulators. They do not use production credentials, publish production rules, or change real game records.

To run the isolated browser checks locally:

```sh
npm run firebase:browser:rules
firebase emulators:start --only auth,firestore --project demo-catan-browser --config firebase.browser.emulator.json
# In another terminal, after the emulators are ready:
npm run test:firebase-browser
npm run test:firebase-browser-ui
```

Run these suites sequentially: each uses and cleans its own fixture data in the same demo ledger. The UI test uses an isolated Vite fixture to connect to emulators; production code contains no emulator environment switches.
