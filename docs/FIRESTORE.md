# Firestore persistence

The default rankings page uses the **Firebase browser SDK** with Firebase Authentication and owner-only Security Rules. Configure the seven public `VITE_FIREBASE_*` fields and follow [the setup guide](VERCEL.md). Rankings require no backend account, service-account JSON, Vercel IAM grant, or owner password environment variable.

## Existing data

The database remains `inventory-management-6626b`, default Firestore database, with these paths:

```text
catan/rankings                    schema/version/revision/playerIds/gameIds
catan/rankings/players/{id}       player ID and name
catan/rankings/games/{id}         date, notes, participants, VP breakdowns
```

The browser uses the same schema as the existing server. Records stay in place; do not delete or re-create the ledger when enabling browser access. An empty database is initialized by the owner's first save. The client refuses incompatible metadata, incomplete records, orphan records, or invalid VP data instead of overwriting them.

Public visitors may read only these rankings documents. **Do not make the entire Catan subtree public.** Its other subcollections can contain private online game state, session hashes, and rate limits. The scoped [rules template](../firestore.rules.example) keeps those inaccessible to browser clients, including the owner.

## Reads, saves, and conflicts

Reads come from the server, validate metadata and record indexes, and retry when the ledger changes during loading. Saves validate the complete proposed ledger, compare its revision in a transaction, and write only changed player/game documents plus the updated metadata. Deletes use the same atomic transaction. A stale owner tab receives a conflict and retains its draft for review.

The application limits a save to 449 changed/deleted player or game documents plus one metadata write, with a conservative request-size guard. Save large imports in smaller groups. Rankings contain at most 500 players and 2,000 games; they are loaded as a complete ledger, so pagination should precede very large archives.

A successful save means Firestore acknowledged it. Offline or failed writes do not silently fall back to browser storage or local files. Refresh after an uncertain network failure before retrying. Firestore records survive browser closure, application restarts, and Vercel redeployments. Backups are still needed to recover intentional deletions.

## Owner access

Enable Firebase Authentication Email/Password and create your own user. Replace `REPLACE_WITH_OWNER_UID` in the rules template with that user's UID and publish the merged rules. The owner signs in through the website. Passwords belong in Firebase Auth and the sign-in form, never in public environment variables. No separate owner UID environment variable is needed: the app checks the rules-protected owner access path.

Client rules do not restrict Google IAM identities such as the existing multiplayer server. Keep that backend's permissions and credentials server-only. [Firebase rules and server access](https://firebase.google.com/docs/firestore/security/get-started).

## Legacy local server and imports

Existing local Node installations can explicitly build with `VITE_RANKINGS_TRANSPORT=http` and use `RANKINGS_STORAGE=file` or their existing server Firestore connection. Only that legacy mode uses `RANKINGS_ADMIN_USERNAME` and `RANKINGS_ADMIN_PASSWORD`. Its Vercel API route is retired.

The existing `rankings:import` command remains a privileged server-side maintenance tool. Use its documented `--help` and an authorized local Admin connection when importing an existing `server/data/rankings.json`. Do not copy a service-account key into the public app or run imports against the live ledger without reviewing the target and backup.

The local Socket.IO server still saves rooms to `CATAN_DATA_DIR/rooms.json`; local pass-and-play remains in browser storage. Hosted rooms use the separate [multiplayer backend](MULTIPLAYER_BACKEND.md). Enabling browser rankings does not migrate or expose room data.

## Emulator verification

Browser tests use an isolated `demo-` Firebase project, real Firebase Web SDK calls, and local Auth/Firestore emulators. The test rules are generated from the production template with a fixture owner UID. Tests cover public reads, owner CRUD, wrong-user denial, private-subcollection denial, revision conflicts, and existing-record preservation. They do not publish rules or access the real database.

Legacy server tests remain available with `npm run test:firebase-web`, `npm run test:firestore`, and `npm run test:rankings`. The last command explicitly builds the local HTTP rankings variant. Build again normally before deploying the browser Firebase variant.
