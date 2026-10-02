# Shared rankings

The **Rankings** page is a public ledger of your group's games. Anyone who can open the site can read it. Only the owner can add or rename players and add, edit, or delete recorded games.

For deployment, the app supports **Cloud Firestore** with `RANKINGS_STORAGE=firestore`. See [Firebase setup and importing existing records](FIRESTORE.md). The browser uses the same API and owner controls with either backend. Firestore configuration errors stop rankings operations; they never cause a silent switch to local files.

Players are ranked by **total victory points across every recorded game**. Equal totals share a rank. Players with no recorded games are shown without a rank. Editing an old game immediately recalculates the standings.

Each game records a date, two to six players, optional notes, and each player's VP breakdown. Enter the number of settlements, cities, and victory point cards; mark Longest Road and Largest Army; use Other VP for house rules or corrections. The total is calculated as settlements + twice the cities + victory point cards + two for each award + other VP. These are manual records, so you can record physical games as well as games played on this site. Starting or finishing a live room does not automatically alter the rankings.

## Set up your owner access locally

1. Run the site on your computer with `npm start` or `npm run dev`.
2. Open it at `http://localhost:3001` (or the local Vite address), then choose **Rankings**.
3. Choose the first-time owner setup option and create a unique password of at least ten characters.
4. Keep the password private. Share the site address with players, who can read the records without signing in.

First-time setup is allowed only through a loopback connection to `localhost`, `127.0.0.1`, or `::1` while `NODE_ENV` is not `production`. Public hostnames, requests forwarded from non-loopback addresses, and production servers cannot claim the owner role through the website. The included Vite proxy forwards source addresses so that only local development requests can set up the owner. After setup, the same password is required to edit from any device. Sign out when you finish on a shared computer.

An owner session lasts twelve hours and ends when the server restarts. Passwords are salted and hashed with scrypt. Session cookies are HTTP-only and restricted to the rankings API. Passwords are never included in public responses or logs.

## Hosting shared rankings

Run one Node server behind HTTPS. Use Firestore for durable cloud rankings, or give file-backed rankings persistent storage through `CATAN_DATA_DIR`. Configure a private environment secret named **`RANKINGS_ADMIN_PASSWORD`** with a unique password of at least ten characters before starting a production deployment. This password secret is required for production Firestore. Use the hosting provider's secret settings; do not put the password in Git or a public frontend variable. The website then offers owner sign-in while everybody else has read-only access.

The environment password takes precedence over saved local owner credentials. It is not written to disk. Changing it and restarting the server changes the owner password and invalidates existing sessions. Production cookies require HTTPS. Failed sign-ins are rate-limited by the immediate connection address; deployments behind one proxy share a conservative limit of ten failed attempts per fifteen minutes. Rankings writes use the site's own origin; a separately hosted frontend on another origin is not supported for this API. The local Vite development proxy is supported.

A locally created `rankings-admin.json` also works on a hosted server when securely transferred with the data directory. Using the hosting provider's environment secret is the recommended deployment setup. If neither a secret nor existing credentials is present in production, rankings remain readable and editing stays disabled.

## Persistence, backup, and recovery

With `RANKINGS_STORAGE=file` (the default without configuration), the data directory contains these independent files:

- `rankings.json`: all registered players, recorded games, and the revision number.
- `rankings-admin.json`: the password's salt and scrypt hash when owner access was set up locally.
- `rooms.json`: live online rooms, managed separately from the rankings ledger.

Rankings do not expire when a room expires. File-backed saves atomically replace the rankings file and use private file permissions. Back up the data directory regularly, particularly before moving to another host. Keep the credentials file private. The rankings.json file itself is a portable backup of the ledger and contains no owner credentials. Firestore stores its ledger and records in the configured cloud document and subcollections, with atomic transactions; it does not write rankings.json. Existing JSON files remain untouched when Firestore is enabled and require an explicit import.

Use a **single server process**: live rooms, owner sessions, and login rate limits remain tied to a process even with Firestore rankings. Hosting file-backed rankings without a persistent disk loses records when the container or deployment is replaced. Firestore rankings survive that replacement independently of the app's disk.

If two owner tabs edit the same revision, the first save succeeds and the second receives a conflict. Reload the latest ledger before saving the other edit; it will not silently overwrite newer records. The server validates dates, player references, per-game player counts, and VP fields even when a request bypasses the interface.

A corrupt or unreadable saved ledger disables the rankings API with an explanatory error and preserves the file. The live game server continues running. Stop the server, back up the damaged file, restore a known-good `rankings.json`, and restart. An invalid credentials file is likewise preserved. To recover owner access without changing game records, set a new `RANKINGS_ADMIN_PASSWORD` and restart. A password shorter than ten characters disables rankings authentication until corrected.

## Verification

```sh
npm test
npm run test:rankings
```

The rankings command builds the app, runs HTTP integration checks, and runs browser tests. Every rankings test server uses a temporary data directory; your real ledger is untouched. HTTP checks cover public reading, owner-only writes, password hashing, session revocation, local setup restrictions, origin enforcement, data persistence, optimistic revisions, validation, login rate limiting, production configuration, and preservation of a corrupt ledger. Browser checks cover recording, editing, deleting, player renames, shared read-only access, six-player records, mobile layout, conflict recovery, and retained drafts after a session expires.
