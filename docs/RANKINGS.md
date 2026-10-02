# Shared rankings

The **Rankings** page is a public ledger of your group's games. Anyone who can open the site can read it. Only the owner can add or rename players and add, edit or delete recorded games.

Players rank by **total victory points across the selected games**. With no date filter, every recorded game counts. Equal totals share a rank. Players with no games appear without a rank. Editing an old game recalculates the standings.

The final standings column is **Wins**, replacing Best. Each game's highest positive VP score earns a win; if players tie for that score, each receives a win. A game in which every player scores zero awards no wins. Wins are displayed separately and do not change ranking by total VP.

Use **From date** and **To date** to filter the summary statistics, standings and game chronicle. Both endpoints are inclusive, and either endpoint can be left empty. **All dates** clears the range. While a date filter is active, only players with games in that range appear, and their totals and wins include only those games. An invalid range shows an error until corrected. Filters only change the view; they never alter saved players or game records.

Each game records a date, two to six players, optional notes and each player's VP breakdown. Enter settlements, cities and victory point cards; mark Longest Road and Largest Army; use Other VP for house rules or corrections. The total is settlements + twice the cities + victory point cards + two for each award + other VP. These are manual records and can include tabletop games. Live rooms do not automatically change rankings.

## Owner access

Set `RANKINGS_ADMIN_USERNAME` and `RANKINGS_ADMIN_PASSWORD` as server Secrets in Vercel. Choose any non-empty password, up to 1,024 UTF-8 bytes. Open **Owner sign in** and enter that username/password. Follow [the setup guide](VERCEL.md) for the public Firebase config and private server credential.

The Catan API verifies the owner and issues a twelve-hour HTTP-only session cookie. Sign-in survives page reloads. **Lock editing** revokes the session. If a save needs a new login or conflicts with another edit, the draft remains available for review. There is no public owner-registration form.

Firebase Authentication and an owner UID are not used. The browser's Firebase access is read-only, even if somebody signs into Firebase or modifies the browser code. All edits require the server owner session and are checked by the API.

## Persistence and recovery

The browser reads public metadata, players and games directly from Firestore. The server saves changes through the Firebase Admin SDK using the existing private credential. Room state, session hashes and login limits remain private. Configure the [Vercel variables and scoped read-only rules](VERCEL.md); records remain in the existing ledger.

With local `RANKINGS_STORAGE=file` and `VITE_RANKINGS_TRANSPORT=http`, `CATAN_DATA_DIR/rankings.json` holds players, games and the revision. Atomic writes protect the local file. A hosted container needs persistent storage for file-backed records. Back up the file before moving hosts; it contains no owner password.

Rankings do not expire with online rooms. Vercel rooms use separate Firestore documents, local Socket.IO rooms use `CATAN_DATA_DIR/rooms.json`, and pass-and-play remains in browser storage. Switching to Firestore leaves JSON files untouched; importing them is explicit.

If two owner tabs edit the same revision, the first save succeeds and the second receives a conflict. Review the latest ledger before applying the other draft. Both client and server validate dates, players and VP fields; the server commits the complete change atomically. Public read-only rules do not authorize any direct client writes.

A corrupt or unreadable ledger is preserved and cannot be overwritten through normal edits. Restore a known-good backup to recover damaged records. To recover owner access without changing games, update the two owner environment values and redeploy; previous sessions become invalid on the updated deployment.

## Verification

`npm test` checks scoring, validation, configuration and client/server behavior. The [Firestore emulator checks](FIRESTORE.md#emulator-verification) exercise public reads, direct-write denial and the HTTP owner workflow without production data. `npm run test:rankings` verifies the local HTTP variant and existing desktop/mobile editing flows. Build normally again before deploying the hybrid Firebase variant.
