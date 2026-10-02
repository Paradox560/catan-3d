import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  deleteApp as deleteAdminApp,
  getApps,
  initializeApp as initializeAdminApp,
} from 'firebase-admin/app';
import { getFirestore as getAdminFirestore } from 'firebase-admin/firestore';
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import {
  collection,
  connectFirestoreEmulator,
  doc,
  getDocFromServer,
  getDocsFromServer,
  getFirestore,
  setDoc,
  deleteDoc,
  setLogLevel,
  terminate,
  type Firestore,
} from 'firebase/firestore';
import { rankingsRouter } from '../server/rankings.js';
import {
  createFirebaseRankingsClient,
  type RankingsOwnerClient,
} from '../src/rankings/firebase-client.js';
import { RankingsError, type RankingsAccess, type RankingsReply } from '../src/rankings/types.js';
import {
  buildStandings,
  emptyBreakdown,
  emptyRankings,
  type RankingsData,
} from '../src/rankings/model.js';

// Fixed demo-only fixture: never loads .env, uses cloud credentials, or publishes rules.
assert.ok(
  !process.env.FIRESTORE_EMULATOR_HOST || process.env.FIRESTORE_EMULATOR_HOST === '127.0.0.1:8182',
);
Object.assign(process.env, {
  METADATA_SERVER_DETECTION: 'none',
  NODE_ENV: 'test',
  RANKINGS_STORAGE: 'firestore',
  FIREBASE_AUTH_MODE: 'admin',
  FIREBASE_PROJECT_ID: 'demo-catan-browser',
  FIRESTORE_RANKINGS_DOCUMENT: 'catan/rankings',
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8182',
  RANKINGS_ADMIN_USERNAME: 'catan-owner',
  RANKINGS_ADMIN_PASSWORD: 'Owner-emulator-123!',
});
delete process.env.VERCEL;
delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
setLogLevel('silent');
const projectId = 'demo-catan-browser';
const adminApp = initializeAdminApp({ projectId }, 'catan-hybrid-smoke-admin');
const admin = getAdminFirestore(adminApp);
const root = admin.doc('catan/rankings');
const directory = await mkdtemp(path.join(tmpdir(), 'catan-hybrid-smoke-'));
const app = express();
app.use('/api/rankings', rankingsRouter(directory));
const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
});
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const apps: Array<{ app: FirebaseApp; db: Firestore }> = [];
const requests: string[] = [];
function ownerAPI() {
  let cookie = '';
  async function request<T>(suffix = '', method = 'GET', body?: unknown): Promise<T> {
    requests.push(`${method} /api/rankings${suffix}`);
    const response = await fetch(`${origin}/api/rankings${suffix}`, {
      method,
      headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const issued = response.headers.get('set-cookie');
    if (issued) {
      assert.match(issued, /HttpOnly/i);
      assert.match(issued, /SameSite=Strict/i);
      cookie = issued.split(';')[0];
    }
    const payload = await response.json();
    if (!response.ok) throw new RankingsError(payload.error, response.status);
    return payload as T;
  }
  const api: RankingsOwnerClient = {
    loadRankingsAccess: async () => (await request<{ access: RankingsAccess }>('/access')).access,
    loginRankings: (username, password) =>
      request<RankingsReply>('/login', 'POST', { username, password }),
    logoutRankings: () => request<RankingsReply>('/logout', 'POST', {}),
    saveRankings: (data) => request<RankingsReply>('', 'PUT', data),
  };
  return { api, request };
}
function browser(name: string, owner = ownerAPI()) {
  const app = initializeApp(
    {
      apiKey: 'demo-browser-api-key',
      authDomain: `${projectId}.firebaseapp.com`,
      projectId,
      appId: '1:123456789:web:abcdef',
    },
    name,
  );
  const db = getFirestore(app);
  connectFirestoreEmulator(db, '127.0.0.1', 8182);
  apps.push({ app, db });
  return { db, owner, api: createFirebaseRankingsClient({ db }, owner.api) };
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
    (error: unknown) => (error as { code?: string }).code === 'permission-denied',
    label,
  );
}
async function status(operation: Promise<unknown>, expected: number, label: string) {
  await assert.rejects(
    operation,
    (error: unknown) => (error as { status?: number }).status === expected,
    label,
  );
}
try {
  await admin.recursiveDelete(root);
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
  for (const p of existing.players) seed.set(root.collection('players').doc(p.id), p);
  for (const g of existing.games) seed.set(root.collection('games').doc(g.id), g);
  const privatePaths = [
    'catan/rankings/onlineRooms/private-room',
    'catan/rankings/onlineLimits/private-limit',
    'catan/rankings/ownerSessions/private-session',
    'catan/rankings/ownerRateLimits/private-rate',
    'catan/rankings/players/legacy-a/private/secret',
    'catan/other-ledger',
    'inventory/browser-smoke',
  ];
  for (const target of privatePaths) seed.set(admin.doc(target), { private: 'sentinel' });
  await seed.commit();
  const anonymous = browser('catan-public-smoke');
  const owner = browser('catan-owner-smoke');
  assert.deepEqual((await anonymous.api.loadRankings()).data, existing);
  assert.equal((await anonymous.api.readAccess()).authenticated, false);
  await status(anonymous.api.saveRankings(existing), 401, 'anonymous API save');
  await status(
    owner.api.loginRankings('catan-owner', 'wrong-password'),
    401,
    'wrong owner password',
  );
  await denied(
    setDoc(doc(anonymous.db, 'catan/rankings'), metadata({ ...existing, revision: 8 })),
    'anonymous direct metadata write',
  );
  await denied(
    setDoc(doc(anonymous.db, 'catan/rankings/players/legacy-a'), {
      id: 'legacy-a',
      name: 'Intruder',
    }),
    'anonymous direct player write',
  );
  console.log('PASS public SDK reads, denied browser writes, protected owner API');

  const login = await owner.api.loginRankings('catan-owner', 'Owner-emulator-123!');
  assert.equal(login.access.authenticated, true);
  assert.deepEqual(login.data, existing);
  await denied(
    getDocFromServer(doc(owner.db, 'catan/rankings/access/owner')),
    'no Firebase owner UID gate',
  );
  await denied(
    setDoc(doc(owner.db, 'catan/rankings/players/legacy-a'), {
      id: 'legacy-a',
      name: 'Direct owner write',
    }),
    'HTTP owner still cannot write directly to Firebase',
  );
  await denied(
    deleteDoc(doc(owner.db, 'catan/rankings/games/legacy-game')),
    'direct owner deletion',
  );
  console.log(
    'PASS environment username/password and HTTP-only session; Firebase remains read-only',
  );

  const players = Array.from({ length: 6 }, (_, i) => ({
    id: `six-${i}`,
    name: `Player ${i + 1}`,
  }));
  const game = {
    id: 'six-game',
    date: '2026-10-02',
    notes: 'Every VP category',
    results: players.map((p, i) => ({
      playerId: p.id,
      breakdown: {
        settlements: i % 5,
        cities: i % 4,
        victoryCards: i % 6,
        longestRoad: i === 0,
        largestArmy: i === 1,
        other: i,
      },
    })),
  };
  let saved = (
    await owner.api.saveRankings({
      ...existing,
      players: [...existing.players, ...players],
      games: [...existing.games, game],
    })
  ).data;
  assert.equal(saved.revision, 8);
  assert.deepEqual((await anonymous.api.loadRankings()).data, saved);
  assert.deepEqual(saved.games[0], existing.games[0]);
  assert.equal(buildStandings(saved).find((s) => s.player.id === 'six-5')?.totalVP, 12);
  const changed = structuredClone(saved);
  changed.players[2].name = 'Renamed player';
  changed.games[1].date = '2026-10-03';
  changed.games[1].results[0].breakdown = {
    settlements: 5,
    cities: 4,
    victoryCards: 6,
    longestRoad: true,
    largestArmy: true,
    other: 50,
  };
  saved = (await owner.api.saveRankings(changed)).data;
  assert.equal(saved.revision, 9);
  const reloaded = browser('catan-reloaded-smoke', owner.owner);
  assert.deepEqual((await reloaded.api.loadRankings()).data, saved);
  assert.equal((await reloaded.api.readAccess()).authenticated, true);
  console.log(
    'PASS server six-player/full VP create/update and public persistence; existing records retained',
  );

  const second = browser('catan-second-owner-smoke');
  await second.api.loginRankings('catan-owner', 'Owner-emulator-123!');
  const a = structuredClone(saved),
    b = structuredClone(saved);
  a.players[0].name = 'Concurrent A';
  b.players[0].name = 'Concurrent B';
  const raced = await Promise.allSettled([owner.api.saveRankings(a), second.api.saveRankings(b)]);
  assert.equal(raced.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(
    (raced.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.status,
    409,
  );
  saved = (await owner.api.loadRankings()).data;
  await status(owner.api.saveRankings(changed), 409, 'stale edit');
  const invalid = structuredClone(saved);
  invalid.games[0].results[0].breakdown.cities = 99;
  await status(
    owner.owner.request('', 'PUT', invalid),
    400,
    'server validates VP bounds independently',
  );
  assert.deepEqual((await anonymous.api.loadRankings()).data, saved);
  console.log('PASS atomic conflict checks and server validation');

  for (const client of [anonymous, owner]) {
    for (const target of privatePaths) {
      await denied(getDocFromServer(doc(client.db, target)), `private read ${target}`);
      await denied(
        setDoc(doc(client.db, target), { private: 'changed' }),
        `private write ${target}`,
      );
    }
    await denied(
      getDocsFromServer(collection(client.db, 'catan/rankings/onlineRooms')),
      'private room listing',
    );
    await denied(
      getDocsFromServer(collection(client.db, 'catan')),
      'whole Catan collection listing',
    );
  }
  for (const target of privatePaths)
    assert.deepEqual((await admin.doc(target).get()).data(), { private: 'sentinel' });
  console.log('PASS private rooms, sessions, limits and unrelated records stay inaccessible');

  saved = (
    await owner.api.saveRankings({
      ...saved,
      players: saved.players.filter((p) => !p.id.startsWith('six-')),
      games: saved.games.filter((g) => g.id !== 'six-game'),
    })
  ).data;
  assert.equal(saved.players.length, 2);
  assert.equal(saved.games.length, 1);
  assert.equal((await root.collection('games').doc('six-game').get()).exists, false);
  assert.deepEqual((await anonymous.api.loadRankings()).data, saved);
  await owner.api.logoutRankings();
  assert.equal((await owner.api.readAccess()).authenticated, false);
  await status(owner.api.saveRankings(saved), 401, 'revoked session cannot save');
  console.log('PASS atomic deletion and server logout revocation');

  await admin.recursiveDelete(root);
  assert.deepEqual((await anonymous.api.loadRankings()).data, emptyRankings());
  await owner.api.loginRankings('catan-owner', 'Owner-emulator-123!');
  const first = (await owner.api.saveRankings({ ...existing, revision: 0 })).data;
  assert.equal(first.revision, 1);
  assert.deepEqual((await anonymous.api.loadRankings()).data, first);
  assert.ok(requests.includes('GET /api/rankings/access'));
  assert.ok(!requests.includes('GET /api/rankings'), 'public ledger reads never use HTTP API');
  console.log('PASS empty ledger initialized by server; public reads stay on Firebase SDK');
  console.log('Hybrid public Firebase + server-owner smoke passed.');
} finally {
  await Promise.all(
    apps.map(async ({ app, db }) => {
      await terminate(db);
      await deleteApp(app);
    }),
  );
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await admin.recursiveDelete(root);
  await admin.doc('catan/other-ledger').delete();
  await admin.doc('inventory/browser-smoke').delete();
  for (const app of getApps()) {
    await getAdminFirestore(app).terminate();
    await deleteAdminApp(app);
  }
  await rm(directory, { recursive: true, force: true });
}
