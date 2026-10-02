import assert from 'node:assert/strict';
import {
  deleteApp as deleteAdminApp,
  initializeApp as initializeAdminApp,
} from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { Firestore as AdminFirestore } from 'firebase-admin/firestore';
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import {
  collection,
  connectFirestoreEmulator,
  deleteDoc,
  doc,
  getDocFromServer,
  getDocsFromServer,
  getFirestore,
  setLogLevel,
  setDoc,
  terminate,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';
import { createFirebaseRankingsClient } from '../src/rankings/firebase-client.js';
import {
  buildStandings,
  emptyBreakdown,
  emptyRankings,
  type RankingsData,
} from '../src/rankings/model.js';

// These tests only address two fixed loopback emulators and a demo project. They
// never consume local .env files, real Firebase credentials or production data.
const projectId = 'demo-catan-browser';
for (const [key, expected] of Object.entries({
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8182',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9100',
})) {
  assert.ok(process.env[key] === undefined || process.env[key] === expected, `Unexpected ${key}.`);
  process.env[key] = expected;
}
const owner = {
  uid: 'catan-browser-owner',
  email: 'owner@catan.test',
  password: 'Owner-emulator-123!',
};
const outsider = {
  uid: 'catan-browser-outsider',
  email: 'outsider@catan.test',
  password: 'Outsider-emulator-123!',
};
const adminApp = initializeAdminApp(
  {
    projectId,
    credential: { getAccessToken: async () => ({ access_token: 'owner', expires_in: 3600 }) },
  },
  'catan-browser-smoke-admin',
);
const admin = new AdminFirestore({ projectId, host: '127.0.0.1:8182', ssl: false });
const adminAuth = getAdminAuth(adminApp);
const root = admin.doc('catan/rankings');
const apps: Array<{ app: FirebaseApp; db: Firestore }> = [];
// Expected denial checks are asserted below; suppress repetitive SDK transport logs.
setLogLevel('silent');

function browser(name: string) {
  const app = initializeApp(
    {
      apiKey: 'demo-browser-api-key',
      authDomain: `${projectId}.firebaseapp.com`,
      projectId,
      appId: '1:123456789:web:browser',
    },
    name,
  );
  const auth = getAuth(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9100', { disableWarnings: true });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, '127.0.0.1', 8182);
  apps.push({ app, db });
  return { db, auth, api: createFirebaseRankingsClient({ db, auth }) };
}

function metadata(data: RankingsData) {
  return {
    schema: 'catan-rankings-v1',
    version: 1,
    revision: data.revision,
    playerIds: data.players.map((p) => p.id),
    gameIds: data.games.map((g) => g.id),
  };
}

async function denied(operation: Promise<unknown>, label: string) {
  await assert.rejects(
    operation,
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'permission-denied', label);
      return true;
    },
    label,
  );
}

async function rejectedStatus(operation: Promise<unknown>, status: number, label: string) {
  await assert.rejects(
    operation,
    (error: unknown) => {
      assert.equal((error as { status?: number }).status, status, label);
      return true;
    },
    label,
  );
}

try {
  await admin.recursiveDelete(root);
  for (const account of [owner, outsider]) {
    await adminAuth.deleteUser(account.uid).catch((error: { code?: string }) => {
      if (error.code !== 'auth/user-not-found') throw error;
    });
    await adminAuth.createUser(account);
  }
  const existing: RankingsData = {
    version: 1,
    revision: 7,
    players: [
      { id: 'legacy-a', name: 'Existing Ada' },
      { id: 'legacy-b', name: 'Existing Byron' },
    ],
    games: [
      {
        id: 'legacy-game',
        date: '2026-01-02',
        notes: 'Existing ledger must survive.',
        results: [
          {
            playerId: 'legacy-a',
            breakdown: { ...emptyBreakdown(), cities: 3, settlements: 2, longestRoad: true },
          },
          {
            playerId: 'legacy-b',
            breakdown: { ...emptyBreakdown(), settlements: 3, victoryCards: 1 },
          },
        ],
      },
    ],
  };
  const seed = admin.batch().set(root, metadata(existing));
  for (const player of existing.players)
    seed.set(root.collection('players').doc(player.id), player);
  for (const game of existing.games) seed.set(root.collection('games').doc(game.id), game);
  const privatePaths = [
    'catan/rankings/onlineRooms/private-room',
    'catan/rankings/onlineLimits/private-limit',
    'catan/rankings/ownerSessions/private-session',
    'catan/rankings/ownerRateLimits/private-rate',
    'catan/rankings/players/legacy-a/private/secret',
    'catan/other-ledger',
    'inventory/browser-smoke',
  ];
  for (const path of privatePaths) seed.set(admin.doc(path), { private: 'sentinel' });
  await seed.commit();

  const anonymous = browser('catan-anonymous');
  const ownerTab = browser('catan-owner');
  const outsiderTab = browser('catan-outsider');
  const publicReply = await anonymous.api.loadRankings();
  assert.deepEqual(publicReply.data, existing);
  assert.equal(publicReply.access.authenticated, false);
  await denied(
    getDocFromServer(doc(anonymous.db, 'catan/rankings/access/owner')),
    'anonymous owner gate',
  );
  await denied(
    setDoc(doc(anonymous.db, 'catan/rankings'), metadata({ ...existing, revision: 8 })),
    'anonymous metadata write',
  );
  await denied(
    setDoc(doc(anonymous.db, 'catan/rankings/players/legacy-a'), {
      id: 'legacy-a',
      name: 'Intruder',
    }),
    'anonymous child write',
  );
  console.log('PASS anonymous public reads and denied edits');

  await signInWithEmailAndPassword(outsiderTab.auth, outsider.email, outsider.password);
  assert.deepEqual((await outsiderTab.api.loadRankings()).data, existing);
  assert.equal((await outsiderTab.api.loadRankings()).access.authenticated, false);
  await denied(
    getDocFromServer(doc(outsiderTab.db, 'catan/rankings/access/owner')),
    'outsider gate',
  );
  await denied(
    setDoc(doc(outsiderTab.db, 'catan/rankings'), metadata({ ...existing, revision: 8 })),
    'outsider metadata write',
  );
  await signOut(outsiderTab.auth);
  await rejectedStatus(
    outsiderTab.api.loginRankings(outsider.email, outsider.password),
    401,
    'outsider owner login',
  );
  console.log('PASS Firebase authentication alone does not grant owner access');

  const login = await ownerTab.api.loginRankings(owner.email, owner.password);
  assert.equal(login.access.authenticated, true);
  assert.deepEqual(login.data, existing);
  assert.equal(
    (await getDocFromServer(doc(ownerTab.db, 'catan/rankings/access/owner'))).exists(),
    false,
  );
  assert.equal((await root.collection('access').doc('owner').get()).exists, false);
  await denied(
    setDoc(doc(ownerTab.db, 'catan/rankings/access/owner'), { uid: owner.uid }),
    'owner cannot change gate',
  );
  console.log('PASS owner UID gate works without an access document');

  const fullPlayers = Array.from({ length: 6 }, (_, index) => ({
    id: `six-${index}`,
    name: `Player ${index + 1}`,
  }));
  const fullGame = {
    id: 'six-player-game',
    date: '2026-10-02',
    notes: 'Six players, every VP category.',
    results: fullPlayers.map((player, index) => ({
      playerId: player.id,
      breakdown: {
        settlements: index % 5,
        cities: index % 4,
        victoryCards: index % 6,
        longestRoad: index === 0,
        largestArmy: index === 1,
        other: index,
      },
    })),
  };
  let saved = (
    await ownerTab.api.saveRankings({
      ...existing,
      players: [...existing.players, ...fullPlayers],
      games: [...existing.games, fullGame],
    })
  ).data;
  assert.equal(saved.revision, 8);
  assert.deepEqual((await anonymous.api.loadRankings()).data, saved);
  assert.deepEqual(saved.games[0], existing.games[0]);
  assert.equal(
    buildStandings(saved).find((standing) => standing.player.id === 'six-5')?.totalVP,
    12,
  );

  const changed = structuredClone(saved);
  changed.players.find((player) => player.id === 'six-0')!.name = 'Renamed owner entry';
  changed.games.find((game) => game.id === fullGame.id)!.date = '2026-10-03';
  changed.games.find((game) => game.id === fullGame.id)!.results[0].breakdown = {
    settlements: 5,
    cities: 4,
    victoryCards: 6,
    longestRoad: true,
    largestArmy: true,
    other: 50,
  };
  saved = (await ownerTab.api.saveRankings(changed)).data;
  assert.equal(saved.revision, 9);
  assert.deepEqual((await anonymous.api.loadRankings()).data, saved);
  console.log(
    'PASS existing data retained; six-player games and every VP category create/read/update',
  );

  // Independent SDK clients race from one revision. Exactly one succeeds.
  const secondOwner = browser('catan-second-owner');
  await secondOwner.api.loginRankings(owner.email, owner.password);
  assert.equal(ownerTab.auth.currentUser?.uid, owner.uid, 'first owner keeps its Firebase session');
  assert.equal(
    secondOwner.auth.currentUser?.uid,
    owner.uid,
    'second owner has its Firebase session',
  );
  assert.equal(
    (await ownerTab.api.readAccess()).authenticated,
    true,
    'first owner access before race',
  );
  assert.equal(
    (await secondOwner.api.readAccess()).authenticated,
    true,
    'second owner access before race',
  );
  const candidateA = structuredClone(saved);
  const candidateB = structuredClone(saved);
  candidateA.players[0].name = 'Concurrent winner A';
  candidateB.players[0].name = 'Concurrent winner B';
  const raced = await Promise.allSettled([
    ownerTab.api.saveRankings(candidateA),
    secondOwner.api.saveRankings(candidateB),
  ]);
  assert.equal(raced.filter((result) => result.status === 'fulfilled').length, 1);
  const loser = raced.find((result) => result.status === 'rejected') as PromiseRejectedResult;
  assert.equal(loser.reason.status, 409, loser.reason.message);
  saved = (await ownerTab.api.loadRankings()).data;
  assert.equal(saved.revision, 10);
  await rejectedStatus(ownerTab.api.saveRankings(changed), 409, 'stale revision');
  console.log('PASS concurrent and stale revision saves cannot overwrite each other');

  await denied(
    setDoc(doc(ownerTab.db, 'catan/rankings/players/legacy-a'), {
      id: 'legacy-a',
      name: 'Unversioned',
    }),
    'child requires atomic revision',
  );
  await denied(
    deleteDoc(doc(ownerTab.db, 'catan/rankings')),
    'owner cannot delete ledger metadata',
  );
  await denied(
    setDoc(doc(ownerTab.db, 'catan/rankings'), metadata(saved)),
    'metadata requires increment',
  );
  const stray = writeBatch(ownerTab.db);
  stray.set(
    doc(ownerTab.db, 'catan/rankings'),
    metadata({ ...saved, revision: saved.revision + 1 }),
  );
  stray.set(doc(ownerTab.db, 'catan/rankings/players/stray'), { id: 'stray', name: 'Not indexed' });
  await denied(stray.commit(), 'child must appear in metadata index');
  const stillIndexed = writeBatch(ownerTab.db);
  stillIndexed.set(
    doc(ownerTab.db, 'catan/rankings'),
    metadata({ ...saved, revision: saved.revision + 1 }),
  );
  stillIndexed.delete(doc(ownerTab.db, 'catan/rankings/players/legacy-a'));
  await denied(stillIndexed.commit(), 'deleted child must leave metadata index');
  const malformed = writeBatch(ownerTab.db);
  malformed.set(
    doc(ownerTab.db, 'catan/rankings'),
    metadata({ ...saved, revision: saved.revision + 1 }),
  );
  malformed.set(doc(ownerTab.db, `catan/rankings/games/${fullGame.id}`), {
    ...fullGame,
    results: [],
  });
  await denied(malformed.commit(), 'game result list shape rejected by rules');
  const invalidPoints = structuredClone(saved);
  invalidPoints.games[0].results[0].breakdown.cities = 99;
  await rejectedStatus(
    ownerTab.api.saveRankings(invalidPoints),
    400,
    'client validates complete VP bounds',
  );
  assert.deepEqual((await ownerTab.api.loadRankings()).data, saved);
  console.log(
    'PASS rules enforce atomic revision/indexes/basic shape; client enforces complete VP bounds',
  );

  await signInWithEmailAndPassword(outsiderTab.auth, outsider.email, outsider.password);
  for (const browserClient of [anonymous, outsiderTab, ownerTab]) {
    for (const path of privatePaths) {
      await denied(getDocFromServer(doc(browserClient.db, path)), `private read ${path}`);
      await denied(
        setDoc(doc(browserClient.db, path), { private: 'overwritten' }),
        `private write ${path}`,
      );
    }
    await denied(
      getDocsFromServer(collection(browserClient.db, 'catan/rankings/onlineRooms')),
      'private room list',
    );
    await denied(
      getDocsFromServer(collection(browserClient.db, 'catan')),
      'ledger collection list',
    );
  }
  for (const path of privatePaths)
    assert.deepEqual((await admin.doc(path).get()).data(), { private: 'sentinel' });
  console.log(
    'PASS private online rooms, sessions, limits and other application records stay inaccessible',
  );

  saved = (
    await ownerTab.api.saveRankings({
      ...saved,
      players: saved.players.filter((player) => !player.id.startsWith('six-')),
      games: saved.games.filter((game) => game.id !== fullGame.id),
    })
  ).data;
  assert.equal(saved.games.length, 1);
  assert.equal(saved.players.length, 2);
  assert.equal((await root.collection('games').doc(fullGame.id).get()).exists, false);
  assert.equal((await root.collection('players').doc('six-0').get()).exists, false);
  assert.deepEqual((await anonymous.api.loadRankings()).data, saved);
  await ownerTab.api.logoutRankings();
  assert.equal((await ownerTab.api.loadRankings()).access.authenticated, false);
  await denied(
    getDocFromServer(doc(ownerTab.db, 'catan/rankings/access/owner')),
    'signed out owner gate',
  );
  console.log('PASS atomic game/player deletion and logout');

  // An unused ledger can be initialized through the same rules. No access
  // document, backend, service account or administrative SDK runs in the client.
  await admin.recursiveDelete(root);
  await ownerTab.api.loginRankings(owner.email, owner.password);
  assert.deepEqual((await anonymous.api.loadRankings()).data, emptyRankings());
  const first = (await ownerTab.api.saveRankings({ ...existing, revision: 0 })).data;
  assert.equal(first.revision, 1);
  assert.deepEqual((await anonymous.api.loadRankings()).data, first);
  console.log('PASS empty ledger initialization');
  const maximumUpdate = structuredClone(first);
  maximumUpdate.players.push(
    ...Array.from({ length: 400 }, (_, index) => ({
      id: `bulk-player-${index}`,
      name: `Bulk player ${index}`,
    })),
  );
  maximumUpdate.games.push(
    ...Array.from({ length: 49 }, (_, index) => ({
      id: `bulk-game-${index}`,
      date: '2026-10-02',
      notes: 'Rules request budget verification.',
      results: maximumUpdate.players.slice(0, 6).map((player) => ({
        playerId: player.id,
        breakdown: { ...emptyBreakdown(), cities: 4, settlements: 5 },
      })),
    })),
  );
  const bulk = (await ownerTab.api.saveRankings(maximumUpdate)).data;
  assert.equal(bulk.revision, 2);
  assert.equal(bulk.players.length, 402);
  assert.equal(bulk.games.length, 50);
  assert.deepEqual((await anonymous.api.loadRankings()).data, bulk);
  console.log('PASS maximum 449 changed records plus metadata fits Security Rules request budgets');
  console.log('Firebase browser SDK and production-template Security Rules smoke passed.');
} finally {
  await Promise.all(
    apps.map(async ({ app, db }) => {
      await terminate(db);
      await deleteApp(app);
    }),
  );
  await admin.recursiveDelete(root);
  await admin.doc('catan/other-ledger').delete();
  await admin.doc('inventory/browser-smoke').delete();
  await Promise.all(
    [owner, outsider].map((account) => adminAuth.deleteUser(account.uid).catch(() => {})),
  );
  await admin.terminate();
  await deleteAdminApp(adminApp);
}
