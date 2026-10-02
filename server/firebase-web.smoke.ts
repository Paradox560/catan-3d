/** Local-only Auth + Firestore integration: npm run test:firebase-web (both emulator hosts required). */
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import express from 'express';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getApps, deleteApp as deleteWebApp } from 'firebase/app';
import { createRankingsFirestore, type RankingsFirestore } from './firebase.js';
import { createWebAuth } from './firebase-web-auth.js';
import { FirestoreRankingsStore } from './rankings-firestore.js';
import { rankingsRouter } from './rankings.js';
import { FirestoreOnlineRooms, onlineRouter, type OnlineReply } from './online.js';
import { emptyBreakdown, emptyRankings, type RankingsData } from '../src/rankings/model.js';
import { legalBuilds } from '../src/game/engine.js';
import type { RoomSnapshot, Session } from '../src/network.js';

const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '';
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
for (const host of [authHost, firestoreHost]) {
  assert.match(
    host,
    /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/,
    'Only explicit loopback emulators are allowed; this test never uses a cloud database.',
  );
  await fetch(`http://${host}/`, { signal: AbortSignal.timeout(3_000) });
}
for (const key of Object.keys(process.env)) {
  if (/^(FIREBASE_|FIRESTORE_|GOOGLE_|GCLOUD_|RANKINGS_)/.test(key)) delete process.env[key];
}
const projectId = 'demo-catan-web';
const id = `web-test-${process.pid}-${randomBytes(5).toString('hex')}`;
const documentPath = `catan/${id}`;
const backendUid = 'catan-test-backend';
const backendEmail = 'catan-test-backend@example.invalid';
const backendPassword = `isolated-${randomBytes(20).toString('hex')}`;
const outsiderUid = `outsider-${id}`;
const outsiderEmail = `outsider-${id}@example.invalid`;
const ownerUsername = 'web-smoke-owner';
const ownerPassword = `owner-${randomBytes(20).toString('hex')}`;
const directory = mkdtempSync(path.join(tmpdir(), 'catan-web-auth-'));
const config: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  METADATA_SERVER_DETECTION: 'none',
  RANKINGS_STORAGE: 'firestore',
  FIREBASE_AUTH_MODE: 'web',
  FIREBASE_PROJECT_ID: projectId,
  FIREBASE_API_KEY: 'fake-api-key',
  FIREBASE_AUTH_DOMAIN: `${projectId}.firebaseapp.com`,
  FIREBASE_APP_ID: '1:123456789:web:012345abcdef',
  FIREBASE_BACKEND_EMAIL: backendEmail,
  FIREBASE_BACKEND_PASSWORD: backendPassword,
  FIREBASE_BACKEND_UID: backendUid,
  FIREBASE_AUTH_EMULATOR_HOST: authHost,
  FIRESTORE_EMULATOR_HOST: firestoreHost,
  FIRESTORE_RANKINGS_DOCUMENT: documentPath,
  RANKINGS_ADMIN_USERNAME: ownerUsername,
  RANKINGS_ADMIN_PASSWORD: ownerPassword,
};
Object.assign(process.env, config);
const adminApp = initializeApp({ projectId }, `fixture-${id}`);
const adminAuth = getAuth(adminApp);
const adminDatabase = getFirestore(adminApp);
adminDatabase.settings({ host: firestoreHost, ssl: false });
const ledger = adminDatabase.doc(documentPath);
const connections: RankingsFirestore[] = [];
const servers: Server[] = [];
const startingApps = new Set(getApps());
const ownedDocuments = [documentPath, `catan/${id}-unrelated`];
const own = (env: NodeJS.ProcessEnv = config) => {
  const connection = createRankingsFirestore(env);
  connections.push(connection);
  return connection;
};
async function start(connection: RankingsFirestore) {
  const app = express();
  app.use('/api/rankings', rankingsRouter(directory));
  app.use(
    '/api/online',
    onlineRouter({ store: new FirestoreOnlineRooms(connection.firestore, documentPath) }),
  );
  const server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
interface RankingsReply {
  data: RankingsData;
  access: { authenticated: boolean; configured: boolean; canSetup: boolean };
  error?: string;
}
async function rankings(base: string, method = 'GET', body?: unknown, cookie = '', route = '') {
  const response = await fetch(`${base}/api/rankings${route}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(method === 'GET' ? {} : { origin: base, 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  return { response, value: (await response.json()) as RankingsReply };
}
async function ownerLogin(base: string) {
  const value = await rankings(
    base,
    'POST',
    { username: ownerUsername, password: ownerPassword },
    '',
    '/login',
  );
  assert.equal(value.response.status, 200, JSON.stringify(value.value));
  assert.equal(value.value.access.authenticated, true);
  assert.match(value.response.headers.get('set-cookie') ?? '', /HttpOnly/i);
  return value.response.headers.get('set-cookie')!.split(';')[0];
}
interface Player {
  base: string;
  connection: string;
  session?: Session;
  state?: RoomSnapshot;
}
function player(base: string): Player {
  return { base, connection: randomBytes(24).toString('hex') };
}
async function roomRequest(client: Player, route: string, body?: unknown) {
  const response = await fetch(`${client.base}/api/online${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'X-Catan-Connection': client.connection,
      ...(client.session ? { Authorization: `Bearer ${client.session.token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json', origin: client.base }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const value = (await response.json()) as OnlineReply & { error?: string };
  if (value.session) client.session = value.session;
  if (value.state) client.state = value.state;
  return { status: response.status, value };
}
async function roomRead(client: Player) {
  const result = await roomRequest(client, `/rooms/${client.session!.code}`);
  assert.equal(result.status, 200, JSON.stringify(result.value));
  return client.state!;
}
async function command(client: Player, event: string, body: Record<string, unknown> = {}) {
  await roomRead(client);
  const result = await roomRequest(client, `/rooms/${client.session!.code}/${event}`, {
    ...body,
    revision: client.state!.revision,
  });
  assert.equal(result.status, 200, JSON.stringify(result.value));
  return client.state!;
}
try {
  // Admin access is confined to this demo emulator's fixture setup and cleanup.
  try {
    await adminAuth.createUser({ uid: backendUid, email: backendEmail, password: backendPassword });
  } catch (error) {
    if ((error as { code?: string }).code !== 'auth/uid-already-exists') throw error;
    assert.equal((await adminAuth.getUser(backendUid)).email, backendEmail);
    await adminAuth.updateUser(backendUid, { password: backendPassword });
  }
  await adminAuth.createUser({ uid: outsiderUid, email: outsiderEmail, password: backendPassword });
  await adminDatabase
    .doc(ownedDocuments[1])
    .set({ unrelated: 'Preserve this fixture outside the selected ledger.' });
  const first = own();
  const second = own();
  const firstStore = new FirestoreRankingsStore(first.firestore, documentPath);
  const secondStore = new FirestoreRankingsStore(second.firestore, documentPath);
  assert.deepEqual(await firstStore.read(), emptyRankings());
  const firstURL = await start(first);
  const secondURL = await start(second);
  assert.deepEqual((await rankings(firstURL)).value.access, {
    authenticated: false,
    configured: true,
    canSetup: false,
  });
  assert.equal((await rankings(firstURL, 'PUT', emptyRankings())).response.status, 401);
  assert.equal(
    (
      await rankings(
        firstURL,
        'POST',
        { username: 'wrong-owner', password: ownerPassword },
        '',
        '/login',
      )
    ).response.status,
    401,
  );
  assert.equal((await rankings(firstURL, 'POST', {}, '', '/setup')).response.status, 403);
  let cookie = await ownerLogin(firstURL);
  assert.equal(
    (await rankings(secondURL, 'GET', undefined, cookie)).value.access.authenticated,
    true,
    'Owner cookies work on another API instance.',
  );
  let data: RankingsData = {
    ...emptyRankings(),
    players: [
      { id: 'ada', name: 'Ada' },
      { id: 'bob', name: 'Bob' },
    ],
    games: [
      {
        id: 'first',
        date: '2026-10-02',
        notes: 'Authenticated web-config fixture',
        results: [
          {
            playerId: 'ada',
            breakdown: {
              ...emptyBreakdown(),
              settlements: 2,
              cities: 2,
              longestRoad: true,
              victoryCards: 2,
            },
          },
          { playerId: 'bob', breakdown: { ...emptyBreakdown(), settlements: 3, cities: 1 } },
        ],
      },
    ],
  };
  let saved = await rankings(firstURL, 'PUT', data, cookie);
  assert.equal(saved.response.status, 200, JSON.stringify(saved.value));
  data = saved.value.data;
  assert.equal(data.revision, 1);
  assert.deepEqual(await secondStore.read(), data);
  const left = structuredClone(data),
    right = structuredClone(data);
  left.games[0].notes = 'First concurrent edit';
  right.games[0].notes = 'Second concurrent edit';
  const conflict = await Promise.all([
    rankings(firstURL, 'PUT', left, cookie),
    rankings(secondURL, 'PUT', right, cookie),
  ]);
  assert.deepEqual(conflict.map((item) => item.response.status).sort(), [200, 409]);
  data = conflict.find((item) => item.response.status === 200)!.value.data;
  const cold = own();
  assert.deepEqual(
    await new FirestoreRankingsStore(cold.firestore, documentPath).read(),
    data,
    'A fresh web-auth client reads the persisted ledger.',
  );

  const sessionKey = createHash('sha256').update(cookie.split('=')[1]).digest('hex');
  const session = ledger.collection('ownerSessions').doc(sessionKey);
  const sessionValue = (await session.get()).data()!;
  assert(sessionValue.expiresAt instanceof Timestamp);
  assert.equal(JSON.stringify(sessionValue).includes(cookie.split('=')[1]), false);
  await session.update({ expiresAt: Timestamp.fromMillis(Date.now() - 1) });
  assert.equal(
    (await rankings(secondURL, 'GET', undefined, cookie)).value.access.authenticated,
    false,
  );
  cookie = await ownerLogin(firstURL);
  assert.equal((await rankings(secondURL, 'POST', {}, cookie, '/logout')).response.status, 200);
  assert.equal(
    (await rankings(firstURL, 'GET', undefined, cookie)).value.access.authenticated,
    false,
  );
  cookie = await ownerLogin(firstURL);
  console.info(
    'Web-config owner login, public ranking reads, atomic edits/conflicts, cold starts, session expiry, and distributed logout passed.',
  );

  const wrongIdentity = createWebAuth({ ...config, FIREBASE_BACKEND_EMAIL: outsiderEmail });
  await assert.rejects(() => wrongIdentity.getToken(), /backend authentication failed/);
  await wrongIdentity.close();
  const outsider = own({
    ...config,
    FIREBASE_BACKEND_EMAIL: outsiderEmail,
    FIREBASE_BACKEND_UID: outsiderUid,
  });
  const protectedPaths = [
    documentPath,
    `${documentPath}/players/ada`,
    `${documentPath}/games/first`,
    `${documentPath}/ownerSessions/${sessionKey}`,
  ];
  for (const protectedPath of protectedPaths) {
    const anonymous = await fetch(
      `http://${firestoreHost}/v1/projects/${projectId}/databases/(default)/documents/${protectedPath}`,
    );
    assert.equal(anonymous.status, 403, 'Anonymous direct database reads are denied.');
    const anonymousWrite = await fetch(
      `http://${firestoreHost}/v1/projects/${projectId}/databases/(default)/documents:commit`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({
          writes: [
            {
              update: {
                name: `projects/${projectId}/databases/(default)/documents/${protectedPath}`,
                fields: { attemptedOverwrite: { booleanValue: true } },
              },
            },
          ],
        }),
      },
    );
    assert.equal(
      anonymousWrite.status,
      403,
      'A website owner cookie cannot authorize direct Firestore writes.',
    );
    await assert.rejects(() => outsider.firestore.doc(protectedPath).get(), /PERMISSION_DENIED/);
    await assert.rejects(
      () => outsider.firestore.doc(protectedPath).set({ attemptedOverwrite: true }),
      /PERMISSION_DENIED/,
    );
  }
  assert.deepEqual(await firstStore.read(), data);
  const orphan = ledger.collection('players').doc('orphan');
  await orphan.set({ id: 'orphan', name: 'Unexpected fixture' });
  assert.equal(
    (await rankings(firstURL)).response.status,
    503,
    'Transactional collection queries detect orphan records.',
  );
  await orphan.delete();
  assert.deepEqual((await rankings(firstURL)).value.data, data);
  console.info(
    'Firebase Auth identity checks and rules denial for anonymous/unrelated users passed; orphan detection preserved.',
  );

  for (const capacity of [4, 6]) {
    const players = Array.from({ length: capacity }, (_, index) =>
      player(index % 2 ? secondURL : firstURL),
    );
    const host = players[0];
    assert.equal(
      (
        await roomRequest(host, '/create', {
          name: 'Host',
          mode: capacity > 4 ? 'extension' : 'standard',
          capacity,
        })
      ).status,
      200,
    );
    for (let index = 1; index < players.length; index++) {
      assert.equal(
        (
          await roomRequest(players[index], '/join', {
            code: host.session!.code,
            name: `Player ${index}`,
          })
        ).status,
        200,
      );
    }
    assert.equal((await roomRequest(player(firstURL), `/rooms/${host.session!.code}`)).status, 401);
    await command(host, 'start');
    assert.equal(host.state!.game!.board.hexes.length, capacity > 4 ? 30 : 19);
    while (host.state!.game!.phase.startsWith('setup')) {
      const game = host.state!.game!;
      const actor = players[game.currentPlayer];
      const kind = game.phase === 'setupSettlement' ? 'settlement' : 'road';
      const positions = legalBuilds(game, kind);
      assert(positions.length);
      await command(actor, 'action', { action: { type: 'BUILD', kind, id: positions[0] } });
      await roomRead(host);
    }
    for (const client of players) {
      const snapshot = await roomRead(client);
      assert.equal(snapshot.game!.rng, 0);
      assert.equal(snapshot.game!.config.seed, 'online-private');
      assert(snapshot.game!.deck.every((card) => card === 'victory'));
      for (const opponent of snapshot.game!.players.filter((item) => item.id !== snapshot.you)) {
        assert.deepEqual(opponent.resources, { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 });
        assert.deepEqual(opponent.devCards, []);
      }
      assert.equal(JSON.stringify(snapshot).includes('tokenHash'), false);
    }
    const path = `${documentPath}/onlineRooms/${host.session!.code}`;
    assert.equal(
      (
        await fetch(
          `http://${firestoreHost}/v1/projects/${projectId}/databases/(default)/documents/${path}`,
        )
      ).status,
      403,
    );
    await assert.rejects(() => outsider.firestore.doc(path).get(), /PERMISSION_DENIED/);
    const stored = (await adminDatabase.doc(path).get()).data()!;
    assert.equal(JSON.stringify(stored).includes(host.session!.token), false);
    await roomRead(host);
    const revision = host.state!.revision;
    const simultaneous = await Promise.all([
      roomRequest(host, `/rooms/${host.session!.code}/action`, {
        revision,
        action: { type: 'ROLL' },
      }),
      roomRequest({ ...host, base: secondURL }, `/rooms/${host.session!.code}/action`, {
        revision,
        action: { type: 'ROLL' },
      }),
    ]);
    assert.deepEqual(simultaneous.map((item) => item.status).sort(), [200, 412]);
  }
  assert.deepEqual(
    await firstStore.read(),
    data,
    'Rooms and owner sessions never alter recorded rankings.',
  );
  assert.deepEqual((await adminDatabase.doc(ownedDocuments[1]).get()).data(), {
    unrelated: 'Preserve this fixture outside the selected ledger.',
  });
  saved = await rankings(firstURL, 'PUT', { ...data, games: [] }, cookie);
  assert.equal(saved.response.status, 200);
  assert.deepEqual((await rankings(secondURL)).value.data.games, []);
  for (let attempt = 0; attempt < 10; attempt++) {
    const base = attempt % 2 ? firstURL : secondURL;
    assert.equal(
      (
        await rankings(
          base,
          'POST',
          { username: ownerUsername, password: 'incorrect-fixture-password' },
          '',
          '/login',
        )
      ).response.status,
      401,
    );
  }
  for (const base of [firstURL, secondURL]) {
    const limited = await rankings(
      base,
      'POST',
      { username: ownerUsername, password: ownerPassword },
      '',
      '/login',
    );
    assert.equal(
      limited.response.status,
      429,
      'The authenticated REST backend shares owner login limits across API instances.',
    );
    assert(Number(limited.response.headers.get('retry-after')) > 0);
  }
  console.info(
    'Authenticated web-config four/six-player online setup, hidden-state privacy, cross-instance concurrency, and rankings deletion passed.',
  );
} finally {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeIdleConnections();
        }),
    ),
  );
  await Promise.all(connections.map((connection) => connection.close()));
  await Promise.all(
    getApps()
      .filter((app) => !startingApps.has(app))
      .map((app) => deleteWebApp(app).catch(() => {})),
  );
  for (const ownedPath of ownedDocuments)
    await adminDatabase.recursiveDelete(adminDatabase.doc(ownedPath));
  for (const uid of [outsiderUid, backendUid]) await adminAuth.deleteUser(uid).catch(() => {});
  await adminDatabase.terminate();
  await deleteApp(adminApp);
  rmSync(directory, { recursive: true, force: true });
}
