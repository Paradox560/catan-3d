# Shared rankings

The **Rankings** page is a public ledger of your group's games. Anyone who can open the site can read it. Only the owner can add or rename players and add, edit, or delete recorded games.

Players rank by **total victory points across every recorded game**. Equal totals share a rank. Players with no recorded games appear without a rank. Editing an old game recalculates the standings.

Each game records a date, two to six players, optional notes, and each player's VP breakdown. Enter the number of settlements, cities, and victory point cards; mark Longest Road and Largest Army; use Other VP for house rules or corrections. The total is settlements + twice the cities + victory point cards + two for each award + other VP. Records are manual: you can include tabletop games, and starting or finishing a live room does not automatically change rankings.

## Owner access

Configure both private server environment variables:

| Variable                  | Requirement                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| `RANKINGS_ADMIN_USERNAME` | Your chosen username, 1–128 characters without leading/trailing whitespace or control characters |
| `RANKINGS_ADMIN_PASSWORD` | Your chosen password, at least 10 characters and at most 1,024 UTF-8 bytes                       |

Locally, set them in the ignored `.env` file and restart `npm start` or `npm run dev`. On Vercel, add them to the project's environment settings and redeploy. See the [Vercel configuration checklist](VERCEL.md). Open `/#rankings`, choose **Owner sign in**, and enter both values. Sign out when you finish on a shared computer.

There is no first-time owner setup through the website. The retired `/api/rankings/setup` endpoint rejects requests, and old `rankings-admin.json` files are neither read nor changed. The environment variables are the only owner identity. Missing, partial, or invalid owner credentials disable editing while public rankings remain readable when the data store is configured.

Credentials are checked with scrypt and timing-safe comparisons. They are never included in public responses, stored in the ledger, or written to a credentials file. Keep them out of Git and public frontend variables. Owner cookies are HTTP-only, SameSite Strict, restricted to `/api/rankings`, and Secure in production; hosted owner access requires HTTPS.

## Sessions and deployment

An owner session lasts twelve hours. With `RANKINGS_STORAGE=firestore`, hashed session identifiers live in the private `ownerSessions` subcollection beneath the configured rankings document. Sessions work across Vercel function instances and survive cold starts or redeployments when credentials stay the same. Signing out revokes the session across instances. Changing either owner environment variable and redeploying invalidates existing sessions on the new deployment.

Firestore also shares a transactional, account-wide limit of ten sign-in attempts per fifteen minutes. A successful login resets that limit. This limit cannot be bypassed by switching function instances or supplying a different forwarded IP address. Both session expiry and rate-limit windows are enforced by the application; they do not depend on background database cleanup.

File storage is intended for one long-running Node process. Its sessions and login limits live in memory; restarting that process requires signing in again. Credentials still come only from the environment.

The rankings API accepts changes from the same website origin. The included local Vite proxy is supported; a separately hosted frontend calling this API from another origin is not supported.

## Persistence and recovery

For Vercel, use **Cloud Firestore** with `RANKINGS_STORAGE=firestore`. See [Firebase setup and importing existing records](FIRESTORE.md). Ledger metadata and player/game documents persist independently of the application deployment. A database connection or configuration error returns an error; the API never falls back to local files.

With `RANKINGS_STORAGE=file`, `CATAN_DATA_DIR/rankings.json` stores all players, recorded games, and the revision number. Writes use atomic file replacement and private file permissions. A persistent disk is necessary to retain file-backed data when a hosted container is replaced. Back up `rankings.json` before moving hosts. It contains no owner credentials.

Rankings do not expire when an online room expires. Vercel online rooms use separate Firestore documents; local Socket.IO rooms use `CATAN_DATA_DIR/rooms.json`. Local pass-and-play stays in browser storage. Enabling Firestore leaves existing JSON files untouched; importing them requires an explicit command.

If two owner tabs edit the same revision, the first save succeeds and the second receives a conflict. Review the latest ledger before applying the other edit. The server validates dates, player references, per-game player counts, and VP fields even when a request bypasses the interface.

A corrupt or unreadable saved ledger disables rankings operations and preserves the original data. For a damaged local file, stop the server, back it up, restore a known-good `rankings.json`, and restart. For cloud records, restore from your Firestore backup. To recover owner access without changing games, update `RANKINGS_ADMIN_USERNAME` and `RANKINGS_ADMIN_PASSWORD`, then restart locally or redeploy on Vercel.

## Verification

```sh
npm test
npm run test:rankings
```

The rankings command builds the app, runs HTTP integration checks, and runs browser tests using temporary local storage. Checks cover public reading, environment-only owner access, generic login failures, session revocation, origin enforcement, CRUD, persistence, revision conflicts, validation, rate limiting, HTTPS cookies, and preservation of a corrupt ledger. Browser workflows cover player renames, shared read-only access, six-player records, mobile layout, conflict recovery, and retaining a draft after the session expires.

The [Firestore emulator checks](FIRESTORE.md#emulator-verification) additionally verify sessions across separate processes, cold starts, distributed logout and rate limits, credential rotation, and expiration. Tests do not use your real ledger or Firebase credentials.
