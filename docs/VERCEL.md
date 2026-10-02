# Deploy Catan on Vercel

This repository includes a Vercel deployment for the 3D frontend, shared rankings, owner editing, and online rooms. The linked project is **catan-3d** in **pranavs-projects-e233eba1**. Project linkage is local CLI metadata; it does not contain Firebase credentials and is excluded from Git.

## Environment variables to add

In the Vercel project, open **Settings → Environment Variables**. Add these values to **Production**. Add them to **Preview** too if preview deployments should access the same records. Sharing a Firestore document means previews and production can edit the same ledger; use another document path when you want isolated preview records.

| Name                            | Value to supply                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------- |
| `RANKINGS_STORAGE`              | `firestore`                                                                       |
| `FIREBASE_PROJECT_ID`           | `inventory-management-6626b`                                                      |
| `FIRESTORE_RANKINGS_DOCUMENT`   | `catan/rankings`                                                                  |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | The complete contents of your downloaded Firebase Admin service-account JSON file |
| `RANKINGS_ADMIN_USERNAME`       | Your chosen owner username                                                        |
| `RANKINGS_ADMIN_PASSWORD`       | Your chosen private password, at least 10 characters                              |

`FIRESTORE_DATABASE_ID` is optional and defaults to `(default)`. Set it only if you use a named Firestore database. Owner usernames accept 1–128 characters without leading/trailing whitespace or control characters; passwords accept up to 1,024 UTF-8 bytes.

Mark the service-account JSON and owner credentials as sensitive where Vercel offers that option. Paste the original JSON contents, including its private key, directly into Vercel's private environment value. It is not a Firebase web API key, a local file path, or a base64 string. Never put those values in `VITE_` variables or commit them. Do not set `GOOGLE_APPLICATION_CREDENTIALS` alongside the JSON secret, and leave `FIRESTORE_EMULATOR_HOST` unset on Vercel.

No `PORT`, `CATAN_DATA_DIR`, `ALLOWED_ORIGINS`, or extra session secret is needed for this deployment. The public build option `VITE_ONLINE_TRANSPORT=http` is already set by `vercel.json`; it contains no credential.

**Redeploy after adding or changing environment variables.** Existing deployments keep the environment they were created with. See [Vercel environment variables](https://vercel.com/docs/environment-variables) and [deployments](https://vercel.com/docs/deployments).

## Deployment configuration

`vercel.json` configures the Vite build, `dist` output, API routing, and no-cache API headers. The build command is:

```sh
VITE_ONLINE_TRANSPORT=http npm run build
```

The Node function in `api/index.ts` mounts the rankings and online-room Express routers. It does not start a listening server, write persistent state to the function filesystem, or need a WebSocket connection. Keep the project root set to this repository and retain the checked-in build configuration.

Deploy from the linked Desktop repository with the Vercel CLI:

```sh
cd ~/Desktop/catan-3d
npx vercel --prod
```

You can also connect a Git remote to the project and deploy pushes through Vercel. A local Git repository or CLI project link alone does not establish automatic Git deployments.

A deployment without its Firebase settings still serves the frontend and local pass-and-play. Rankings and online rooms report that cloud storage is unavailable until those values are configured and the app is redeployed. When only owner credentials are missing, configured Firestore rankings remain public but editing is disabled.

## Verify after deployment

1. Open the production URL returned by Vercel. `/api/health` should identify the `catan-3d` service and `http` transport; this endpoint alone does not verify database access.
2. Open `/#rankings` and confirm the expected public records load.
3. Choose **Owner sign in** and enter your configured username and password. Record or edit a game only when you intend to change the shared ledger.
4. Open the same URL in another browser profile. Rankings should be readable, with editing unavailable until owner sign-in.
5. Host an online room and join it from a second browser or device. Confirm lobby updates and start after all required seats join.

Owner cookies last twelve hours and work across function instances. Sessions are stored as hashed identifiers in Firestore. Sign-out revokes that cookie across instances, and changing either owner credential followed by a redeployment invalidates old sessions on the new deployment.

## Storage and multiplayer behavior

All hosted data uses the configured Firestore document as its root:

```text
catan/rankings
  players/{playerId}
  games/{gameId}
  ownerSessions/{hashedToken}
  ownerRateLimits/{hashedLimitKey}
  onlineRooms/{roomCode}
  onlineLimits/{hashedLimitKey}
```

The parent document holds rankings metadata. Rankings writes use revision checks and transactions. Online rooms, hidden game state, seat-token hashes, presence, and room rate limits persist separately and are shared across function instances. Browser clients receive only the game information their seat may see.

Players poll room updates about every two seconds while the page is visible and every fifteen seconds while hidden. Presence is renewed about every thirty seconds; a seat is shown disconnected when its lease expires after seventy-five seconds. Rooms expire after seventy-two hours without activity. Cold starts can delay a request, and this transport incurs Firestore reads while players have a room open. Rankings remain manual and have no room expiry.

Optional Firestore TTL cleanup can target the `expiresAt` field in the transient `ownerSessions`, `ownerRateLimits`, `onlineRooms`, and `onlineLimits` collection groups. The app checks expiration itself, so cleanup is not required for correctness. Keep backups for permanent player and game records. See [Firestore storage and access](FIRESTORE.md).

The standard `npm start` / Docker server continues to use Socket.IO for online play, with one Node process and persistent disk for its local room saves. It is a separate transport from Vercel's shared Firestore room API. Local pass-and-play always saves in that browser.

## Troubleshooting

| Symptom                                        | Check                                                                                                                                          |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend loads but rankings/rooms fail         | Set all Firebase variables in the correct Vercel environment and redeploy. Check that the service account can access the selected database.    |
| Rankings load but owner sign-in is unavailable | Set both `RANKINGS_ADMIN_USERNAME` and `RANKINGS_ADMIN_PASSWORD`, with a password of at least ten characters, then redeploy.                   |
| Correct new credentials do not work            | Make sure you are opening the new production deployment, not an older preview with different environment values.                               |
| Sign-in attempts are rate limited              | Wait for the shared fifteen-minute window to reset. Reloading or switching function instances does not reset it.                               |
| A preview changes production rankings          | Both environments point at the same Firestore document. Configure a separate preview document and redeploy the preview if isolation is needed. |
| Room updates arrive with a short delay         | Vercel rooms use HTTP polling; visible pages normally update about every two seconds.                                                          |
| Sign-in works but another origin cannot save   | Open the frontend and API on the same HTTPS origin. The API does not allow cross-origin owner edits.                                           |
