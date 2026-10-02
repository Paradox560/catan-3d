# Shared rankings

The **Rankings** page is a public ledger of your group's games. Anyone who can open the site can read it. Only the owner can add or rename players and add, edit, or delete recorded games.

Players rank by **total victory points across every recorded game**. Equal totals share a rank. Players with no recorded games appear without a rank. Editing an old game recalculates the standings.

Each game records a date, two to six players, optional notes, and each player's VP breakdown. Enter the number of settlements, cities, and victory point cards; mark Longest Road and Largest Army; use Other VP for house rules or corrections. The total is settlements + twice the cities + victory point cards + two for each award + other VP. Records are manual: you can include tabletop games, and starting or finishing a live room does not automatically change rankings.

## Owner access

The normal rankings page uses **Firebase Authentication**. Follow [the setup guide](VERCEL.md), enable Email/Password, create your owner user, and place that user's UID in the scoped Firestore rules. Then open **Owner sign in** and enter your Firebase email/password.

There are no owner credentials in Vercel environment variables for this mode. The seven public `VITE_FIREBASE_*` fields initialize the SDK; Firestore rules determine who can edit. Only the owner's account passes the protected permission check. Other Firebase accounts cannot edit the ledger.

Sign-in persists for the current browser tab session, including refreshes. **Lock editing** signs out. The page updates editing access when authentication changes while retaining unsaved drafts. When a save requires a new login, the draft remains available afterward. There is no public owner-registration form.

The old Vercel `/api/rankings` API returns 410, so previous owner cookies and server environment passwords cannot edit through that route. Existing local Node installations can explicitly use `VITE_RANKINGS_TRANSPORT=http`; only this legacy mode keeps environment-configured owner usernames/passwords and twelve-hour HTTP-only cookies.

## Persistence and recovery

For Vercel, configure the [browser Firebase fields, Authentication, and rules](VERCEL.md). The browser reads and writes the existing Firestore ledger directly. Public ranking records remain accessible to visitors; private multiplayer and session subcollections remain inaccessible. No Vercel IAM grant is needed for rankings.

With `RANKINGS_STORAGE=file`, `CATAN_DATA_DIR/rankings.json` stores all players, recorded games, and the revision number. Writes use atomic file replacement and private file permissions. A persistent disk is necessary to retain file-backed data when a hosted container is replaced. Back up `rankings.json` before moving hosts. It contains no owner credentials.

Rankings do not expire when an online room expires. Vercel online rooms use separate Firestore documents; local Socket.IO rooms use `CATAN_DATA_DIR/rooms.json`. Local pass-and-play stays in browser storage. Enabling Firestore leaves existing JSON files untouched; importing them requires an explicit command.

If two owner tabs edit the same revision, the first save succeeds and the second receives a conflict. Review the latest ledger before applying the other edit. The shared client validates dates, player references, per-game player counts, and VP fields before saving and when loading records. Firestore Rules enforce the owner identity, record structure, and atomic revision/index updates.

A corrupt or unreadable saved ledger disables rankings operations and preserves the original data. For a damaged local file, stop the server, back it up, restore a known-good `rankings.json`, and restart. For cloud records, restore from your Firestore backup. To recover browser owner access without changing games, reset the Firebase user password through Firebase Authentication. If replacing the owner account, update the UID in the rules. Legacy local HTTP mode still uses its server owner environment variables.

## Verification

`npm test` checks scoring, validation, configuration, client behavior, and server behavior. The browser Firebase emulator suite checks actual Auth, Firestore, owner-only rules, and conflicts without touching the production database. The [Firestore guide](FIRESTORE.md#emulator-verification) describes the test modes.

`npm run test:rankings` verifies the legacy local HTTP variant and existing desktop/mobile editor workflows. It builds with `VITE_RANKINGS_TRANSPORT=http`; use a normal production build for browser Firebase rankings.
