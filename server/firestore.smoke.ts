/** Run only against a local emulator: FIRESTORE_EMULATOR_HOST=127.0.0.1:8181 node --import tsx server/firestore.smoke.ts */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { hashOwnerToken } from './owner-auth';
import { emptyBreakdown, emptyRankings, type RankingsData } from '../src/rankings/model';
import { FirestoreRankingsStore } from './rankings-firestore';
import { importRankings } from './rankings-import';
import { RankingsConflictError, RankingsStorageError, type RankingsStore } from './rankings-store';

const host = process.env.FIRESTORE_EMULATOR_HOST ?? '';
assert.match(
  host,
  /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/,
  'A loopback Firestore emulator is required. This test never uses a cloud database.',
);
await fetch(`http://${host}/`, { signal: AbortSignal.timeout(3_000) });
// A local emulator needs no machine identity. Disable the Google SDK's environment probe.
process.env.METADATA_SERVER_DETECTION = 'none';
const projectId = 'demo-catan-rankings';
const id = `rankings-test-${process.pid}-${randomBytes(6).toString('hex')}`;
const documentPath = `catan/${id}`;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = mkdtempSync(path.join(tmpdir(), 'catan-firestore-test-'));
const username = 'isolated-firestore-owner';
const password = 'isolated-firestore-test-password';
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const app = initializeApp({ projectId }, id);
const firestore = getFirestore(app);
firestore.settings({ host, ssl: false });
const ledgerDocument = firestore.doc(documentPath);
const untouchedDocument = firestore.doc(`catan/${id}-unrelated`);
const ownedPaths = [documentPath, untouchedDocument.path];
const running = new Set<TestServer>();

function isolatedEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (/^(FIREBASE_|FIRESTORE_|GOOGLE_|GCLOUD_|RANKINGS_)/.test(key)) delete environment[key];
  }
  environment.NODE_ENV = 'test';
  return environment;
}

interface Payload {
  data: RankingsData;
  access: { authenticated: boolean; configured: boolean; canSetup: boolean };
  error?: string;
}
interface TestServer {
  process: ChildProcess;
  url: string;
  directory: string;
  cookie: string;
}
async function freePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
async function start(overrides: NodeJS.ProcessEnv = {}, seed?: RankingsData): Promise<TestServer> {
  const dataDirectory = mkdtempSync(path.join(directory, 'server-'));
  if (seed) writeFileSync(path.join(dataDirectory, 'rankings.json'), JSON.stringify(seed));
  const port = await freePort();
  const environment = isolatedEnvironment();
  Object.assign(environment, {
    PORT: String(port),
    CATAN_DATA_DIR: dataDirectory,
    NODE_ENV: 'test',
    RANKINGS_STORAGE: 'firestore',
    FIREBASE_PROJECT_ID: projectId,
    FIRESTORE_RANKINGS_DOCUMENT: documentPath,
    FIRESTORE_EMULATOR_HOST: host,
    RANKINGS_ADMIN_USERNAME: username,
    RANKINGS_ADMIN_PASSWORD: password,
    ...overrides,
  });
  for (const key of Object.keys(environment))
    if (environment[key] === undefined) delete environment[key];
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: ROOT,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const server = {
    process: child,
    url: `http://127.0.0.1:${port}`,
    directory: dataDirectory,
    cookie: '',
  };
  running.add(server);
  let output = '';
  child.stdout?.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    output += String(chunk);
  });
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      if ((await fetch(`${server.url}/api/health`, { signal: AbortSignal.timeout(500) })).ok)
        return server;
    } catch {
      /* The test server is still starting. */
    }
    if (child.exitCode !== null) throw new Error(`Test server exited: ${output}`);
    await pause(50);
  }
  throw new Error(`Test server failed to start: ${output}`);
}
async function stop(server: TestServer): Promise<void> {
  if (server.process.exitCode === null) {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => server.process.kill('SIGKILL'), 3_000);
      server.process.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
      server.process.kill('SIGTERM');
    });
  }
  running.delete(server);
}
async function request(
  server: TestServer,
  method = 'GET',
  body?: unknown,
  authenticated = false,
  route = '',
) {
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers.origin = server.url;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (authenticated) headers.cookie = server.cookie;
  const response = await fetch(`${server.url}/api/rankings${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const value = (await response.json()) as Payload;
  return { response, value };
}
async function login(server: TestServer): Promise<void> {
  const { response, value } = await request(
    server,
    'POST',
    { username, password },
    false,
    '/login',
  );
  assert.equal(response.status, 200, JSON.stringify(value));
  assert.equal(value.access.authenticated, true);
  assert.match(response.headers.get('set-cookie') ?? '', /HttpOnly/);
  server.cookie = response.headers.get('set-cookie')!.split(';')[0];
}
async function save(server: TestServer, data: RankingsData): Promise<RankingsData> {
  const { response, value } = await request(server, 'PUT', data, true);
  assert.equal(response.status, 200, JSON.stringify(value));
  return value.data;
}

async function importCommand(environmentFile: string, sourceFile: string, apply = false) {
  const args = [
    `--env-file-if-exists=${environmentFile}`,
    '--import',
    'tsx',
    'server/rankings-import.ts',
    '--file',
    sourceFile,
    ...(apply ? ['--apply'] : []),
  ];
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: isolatedEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    output += String(chunk);
  });
  return await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Importer command timed out.'));
    }, 30_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      resolve({ code, output });
    });
  });
}

try {
  await firestore.listCollections(); // Fails early if the explicitly local emulator is unavailable.
  await untouchedDocument.set({ keep: 'Existing collection documents must not be changed.' });
  const first = await start();
  let result = await request(first);
  assert.equal(result.response.status, 200, JSON.stringify(result.value));
  assert.deepEqual(result.value.data, emptyRankings());
  assert.deepEqual(result.value.access, {
    authenticated: false,
    configured: true,
    canSetup: false,
  });
  assert.equal((await request(first, 'PUT', emptyRankings())).response.status, 401);
  assert.equal(
    (
      await request(
        first,
        'POST',
        { username, password: 'incorrect-owner-password' },
        false,
        '/login',
      )
    ).response.status,
    401,
  );
  await login(first);

  let data = await save(first, {
    ...emptyRankings(),
    players: [
      { id: 'ada', name: 'Ada' },
      { id: 'bob', name: 'Bob' },
    ],
    games: [
      {
        id: 'first-match',
        date: '2026-10-01',
        notes: 'The first Firestore match',
        results: [
          {
            playerId: 'ada',
            breakdown: {
              ...emptyBreakdown(),
              settlements: 2,
              cities: 2,
              victoryCards: 2,
              longestRoad: true,
            },
          },
          {
            playerId: 'bob',
            breakdown: { ...emptyBreakdown(), settlements: 3, cities: 1, largestArmy: true },
          },
        ],
      },
    ],
  });
  assert.equal(data.revision, 1);
  const importSource = { ...structuredClone(data), revision: 87 };
  assert.deepEqual((await request(first)).value.data, data);
  const metadata = (await ledgerDocument.get()).data();
  assert.deepEqual(metadata, {
    schema: 'catan-rankings-v1',
    version: 1,
    revision: 1,
    playerIds: ['ada', 'bob'],
    gameIds: ['first-match'],
  });
  assert.deepEqual(
    (await ledgerDocument.collection('players').doc('ada').get()).data(),
    data.players[0],
  );
  assert.deepEqual(
    (await ledgerDocument.collection('games').doc('first-match').get()).data(),
    data.games[0],
  );
  assert.equal(
    existsSync(path.join(first.directory, 'rankings.json')),
    false,
    'Firestore writes never create a local ledger.',
  );
  assert.equal(
    existsSync(path.join(first.directory, 'rankings-admin.json')),
    false,
    'Hosted password configuration never creates a credential file.',
  );

  const second = await start();
  assert.notEqual(second.directory, first.directory);
  assert.deepEqual(
    (await request(second)).value.data,
    data,
    'A new server with an empty local data directory reads Firestore.',
  );
  second.cookie = first.cookie;
  assert.equal(
    (await request(second, 'GET', undefined, true)).value.access.authenticated,
    true,
    'An owner cookie is accepted by a separate process without signing in again.',
  );
  const sessionId = hashOwnerToken(first.cookie.split('=')[1]);
  const savedSession = (
    await ledgerDocument.collection('ownerSessions').doc(sessionId).get()
  ).data()!;
  assert.equal(Object.keys(savedSession).sort().join(','), 'expiresAt,fingerprint,version');
  assert.ok(!JSON.stringify(savedSession).includes(password));
  assert.ok(!JSON.stringify(savedSession).includes(username));
  assert.ok(!JSON.stringify(savedSession).includes(first.cookie.split('=')[1]));
  await request(second, 'POST', {}, true, '/logout');
  assert.equal(
    (await request(first, 'GET', undefined, true)).value.access.authenticated,
    false,
    'Logging out on another instance revokes the original cookie everywhere.',
  );
  await login(first);
  await login(second);
  const left = structuredClone(data);
  const right = structuredClone(data);
  left.games[0].notes = 'First simultaneous writer';
  right.games[0].notes = 'Second simultaneous writer';
  const contested = await Promise.all([
    request(first, 'PUT', left, true),
    request(second, 'PUT', right, true),
  ]);
  assert.deepEqual(
    contested.map((item) => item.response.status).sort(),
    [200, 409],
    'Only one writer can commit a shared revision.',
  );
  data = contested.find((item) => item.response.status === 200)!.value.data;
  assert.equal(data.revision, 2);
  assert.deepEqual((await request(first)).value.data, data);
  assert.deepEqual((await request(second)).value.data, data);

  const unchangedPlayer = await ledgerDocument.collection('players').doc('ada').get();
  data.players[1].name = 'Robert';
  data.games[0].date = '2026-09-30';
  data.games[0].results[1].breakdown.victoryCards = 1;
  data = await save(second, data);
  assert.equal(data.revision, 3);
  assert.equal((await ledgerDocument.collection('players').doc('bob').get()).get('name'), 'Robert');
  assert.ok(
    unchangedPlayer.updateTime!.isEqual(
      (await ledgerDocument.collection('players').doc('ada').get()).updateTime!,
    ),
    'Unchanged player documents are not rewritten.',
  );
  await stop(first);
  await stop(second);
  const restarted = await start();
  assert.deepEqual(
    (await request(restarted)).value.data,
    data,
    'Saved rankings survive process restart and replacement of local storage.',
  );
  restarted.cookie = second.cookie;
  assert.equal(
    (await request(restarted, 'GET', undefined, true)).value.access.authenticated,
    true,
    'Owner sessions survive a cold start.',
  );
  await ledgerDocument
    .collection('ownerSessions')
    .doc(hashOwnerToken(restarted.cookie.split('=')[1]))
    .update({ expiresAt: Timestamp.fromMillis(Date.now() - 1) });
  assert.equal(
    (await request(restarted, 'GET', undefined, true)).value.access.authenticated,
    false,
    'Expired sessions are rejected even before optional Firestore TTL cleanup.',
  );
  await login(restarted);
  for (const override of [
    { RANKINGS_ADMIN_USERNAME: 'rotated-owner' },
    { RANKINGS_ADMIN_PASSWORD: 'rotated-owner-test-password' },
    { RANKINGS_ADMIN_USERNAME: undefined },
    { RANKINGS_ADMIN_PASSWORD: undefined },
  ]) {
    const changed = await start(override);
    changed.cookie = restarted.cookie;
    const publicRead = await request(changed, 'GET', undefined, true);
    assert.equal(publicRead.response.status, 200);
    assert.deepEqual(publicRead.value.data, data);
    assert.equal(
      publicRead.value.access.authenticated,
      false,
      'Changed or missing env credentials invalidate previous cookies.',
    );
    assert.equal((await request(changed, 'PUT', data, true)).response.status, 401);
    await stop(changed);
  }
  data.games = [];
  data = await save(restarted, data);
  assert.equal(data.revision, 4);
  assert.equal((await ledgerDocument.collection('games').doc('first-match').get()).exists, false);
  assert.deepEqual((await request(restarted)).value.data, data);
  assert.deepEqual((await untouchedDocument.get()).data(), {
    keep: 'Existing collection documents must not be changed.',
  });
  console.info(
    'Firestore public reading, owner-only writes, shared revisions, CRUD, and restart persistence passed.',
  );

  const orphan = ledgerDocument.collection('players').doc('orphan');
  await orphan.set({ id: 'orphan', name: 'Unexpected player' });
  assert.equal((await request(restarted)).response.status, 503, 'Unindexed children fail closed.');
  assert.equal((await request(restarted, 'PUT', data, true)).response.status, 503);
  assert.equal((await ledgerDocument.get()).get('revision'), 4);
  assert.equal(
    (await orphan.get()).exists,
    true,
    'Integrity failures preserve the unexpected document.',
  );
  await orphan.delete();
  const missing = ledgerDocument.collection('players').doc('ada');
  await missing.delete();
  assert.equal(
    (await request(restarted)).response.status,
    503,
    'A referenced missing player fails closed.',
  );
  await missing.set(data.players[0]);
  assert.deepEqual(
    (await request(restarted)).value.data,
    data,
    'Repairing the ledger restores reads without data loss.',
  );
  await ledgerDocument.delete();
  assert.equal(
    (await request(restarted)).response.status,
    503,
    'Orphaned subcollections are not mistaken for a new empty ledger.',
  );
  await ledgerDocument.set({
    schema: 'catan-rankings-v1',
    version: 1,
    revision: data.revision,
    playerIds: data.players.map((player) => player.id),
    gameIds: [],
  });
  await stop(restarted);

  const occupiedPath = `catan/${id}-occupied`;
  ownedPaths.push(occupiedPath);
  await firestore.doc(occupiedPath).set({ name: 'Unrelated existing data', important: 7 });
  const occupied = await start({ FIRESTORE_RANKINGS_DOCUMENT: occupiedPath });
  assert.equal(
    (await request(occupied)).response.status,
    503,
    'An existing unrelated document is never adopted as a ledger.',
  );
  assert.deepEqual((await firestore.doc(occupiedPath).get()).data(), {
    name: 'Unrelated existing data',
    important: 7,
  });
  await stop(occupied);

  for (const overrides of [
    { FIREBASE_PROJECT_ID: '' },
    { FIRESTORE_RANKINGS_DOCUMENT: 'catan' },
    { FIRESTORE_EMULATOR_HOST: undefined }, // demo projects must never connect to real Firestore.
    { RANKINGS_STORAGE: 'misspelled-storage' },
  ]) {
    const misconfigured = await start(overrides, data);
    assert.equal(
      (await request(misconfigured)).response.status,
      503,
      'Invalid Firestore configuration never falls back to local rankings.',
    );
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(misconfigured.directory, 'rankings.json'), 'utf8')),
      data,
    );
    await stop(misconfigured);
  }
  console.info(
    'Firestore corruption/orphan detection, reserved document protection, and configuration failure safety passed.',
  );

  const ratePath = `catan/${id}-shared-auth`;
  ownedPaths.push(ratePath);
  const authLeft = await start({ FIRESTORE_RANKINGS_DOCUMENT: ratePath });
  const authRight = await start({ FIRESTORE_RANKINGS_DOCUMENT: ratePath });
  for (let attempt = 0; attempt < 10; attempt++) {
    const target = attempt % 2 === 0 ? authLeft : authRight;
    assert.equal(
      (await request(target, 'POST', { username, password: 'wrong-password' }, false, '/login'))
        .response.status,
      401,
    );
  }
  for (const target of [authLeft, authRight]) {
    const limited = await request(target, 'POST', { username, password }, false, '/login');
    assert.equal(
      limited.response.status,
      429,
      'Rate limit is shared across independent server processes.',
    );
    assert.ok(Number(limited.response.headers.get('retry-after')) > 0);
  }
  await stop(authLeft);
  await stop(authRight);
  console.info(
    'Firestore shared sessions, logout, credential rotation, expiry, and distributed rate limits passed.',
  );

  const budgetPath = `catan/${id}-write-budget`;
  ownedPaths.push(budgetPath);
  const budgetStore = new FirestoreRankingsStore(firestore, budgetPath);
  const large: RankingsData = {
    ...emptyRankings(),
    players: Array.from({ length: 450 }, (_, index) => ({
      id: `player-${index}`,
      name: `Player ${index}`,
    })),
  };
  await assert.rejects(
    () => budgetStore.save(large),
    (error: unknown) =>
      error instanceof RankingsStorageError && /too many records/.test(error.message),
  );
  assert.equal(
    (await firestore.doc(budgetPath).get()).exists,
    false,
    'An oversized write never creates partial ledger metadata.',
  );
  assert.equal((await firestore.doc(budgetPath).collection('players').get()).size, 0);
  const boundary = await budgetStore.save({ ...large, players: large.players.slice(0, 449) });
  assert.equal(boundary.players.length, 449);
  const expanded = await budgetStore.save({
    ...boundary,
    players: [...boundary.players, large.players[449]],
  });
  assert.equal(
    expanded.players.length,
    450,
    'The write budget limits changed records, not total historical records.',
  );
  assert.deepEqual(await budgetStore.read(), expanded);
  console.info('Firestore atomic write budget and incremental ledger growth passed.');

  const importPath = `catan/${id}-import`;
  ownedPaths.push(importPath);
  const importStore = new FirestoreRankingsStore(firestore, importPath);
  const sourceFile = path.join(directory, 'source-rankings.json');
  const environmentFile = path.join(directory, 'import.env');
  const sourceContents = `${JSON.stringify(importSource, null, 2)}\n`;
  writeFileSync(sourceFile, sourceContents, { mode: 0o600 });
  writeFileSync(
    environmentFile,
    [
      'RANKINGS_STORAGE=firestore',
      `FIREBASE_PROJECT_ID=${projectId}`,
      `FIRESTORE_RANKINGS_DOCUMENT=${importPath}`,
      `FIRESTORE_EMULATOR_HOST=${host}`,
    ].join('\n'),
    { mode: 0o600 },
  );
  const preview = await importCommand(environmentFile, sourceFile);
  assert.equal(preview.code, 0, preview.output);
  assert.match(preview.output, /Preview: 2 players and 1 games/);
  assert.deepEqual(await importStore.read(), emptyRankings());
  assert.equal(
    (await firestore.doc(importPath).get()).exists,
    false,
    'CLI preview never initializes a ledger.',
  );
  assert.equal((await firestore.doc(importPath).collection('players').get()).size, 0);
  assert.equal((await firestore.doc(importPath).collection('games').get()).size, 0);
  const imported = await importCommand(environmentFile, sourceFile, true);
  assert.equal(imported.code, 0, imported.output);
  assert.match(imported.output, /Imported: 2 players and 1 games/);
  const importedData = await importStore.read();
  assert.deepEqual(
    importedData,
    { ...importSource, revision: 1 },
    'Import preserves names, dates, notes, and all VP breakdowns while starting a fresh destination revision.',
  );
  assert.equal(
    readFileSync(sourceFile, 'utf8'),
    sourceContents,
    'The original JSON backup is byte-for-byte unchanged.',
  );
  const repeated = await importCommand(environmentFile, sourceFile, true);
  assert.equal(repeated.code, 1, repeated.output);
  assert.match(repeated.output, /already initialized/);
  assert.deepEqual(
    await importStore.read(),
    importedData,
    'Repeated import never replaces existing Firestore records.',
  );
  assert.equal(readFileSync(sourceFile, 'utf8'), sourceContents);

  const racePath = `catan/${id}-import-race`;
  ownedPaths.push(racePath);
  const raceStore = new FirestoreRankingsStore(firestore, racePath);
  let markRead!: () => void;
  let permitSave!: () => void;
  const readComplete = new Promise<void>((resolve) => {
    markRead = resolve;
  });
  const resumeImport = new Promise<void>((resolve) => {
    permitSave = resolve;
  });
  const pausedStore: RankingsStore = {
    async read() {
      const current = await raceStore.read();
      markRead();
      await resumeImport;
      return current;
    },
    save(next) {
      return raceStore.save(next);
    },
  };
  const pendingImport = importRankings(pausedStore, importSource, true);
  await readComplete;
  const normalSave = await raceStore.save({
    ...emptyRankings(),
    players: [{ id: 'new-player', name: 'Recorded during import' }],
  });
  await assert.rejects(async () => {
    permitSave();
    await pendingImport;
  }, RankingsConflictError);
  assert.deepEqual(
    await raceStore.read(),
    normalSave,
    'A normal save after the import check wins; the importer refuses to overwrite it.',
  );
  console.info(
    'Firestore import CLI preview/apply, backup preservation, repeated-import protection, and concurrent-save conflict passed.',
  );
} finally {
  await Promise.all([...running].map(stop));
  for (const ownedPath of ownedPaths) await firestore.recursiveDelete(firestore.doc(ownedPath));
  await deleteApp(app);
  rmSync(directory, { recursive: true, force: true });
}
