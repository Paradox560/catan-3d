/** Real HTTP/persistence check: node --import tsx server/rankings.smoke.ts */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyBreakdown, emptyRankings, type RankingsData } from '../src/rankings/model';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'catan-rankings-test-'));
const port = 41_000 + Math.floor(Math.random() * 8_000);
const url = `http://127.0.0.1:${port}`;
const endpoint = `${url}/api/rankings`;
const username = 'test-owner-9723';
const password = 'test-owner-password-9723';
const productionPassword = 'test-hosted-owner-password-6472';
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let server: ChildProcess | null = null;
let output = '';
let production = false;
let cookie = '';

interface Payload {
  data: RankingsData;
  access: { authenticated: boolean; configured: boolean; canSetup: boolean };
  error?: string;
}
async function start(
  options: { production?: boolean; username?: string | null; password?: string | null } = {},
): Promise<void> {
  production = options.production ?? false;
  output = '';
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    RANKINGS_STORAGE: 'file',
    PORT: String(port),
    CATAN_DATA_DIR: dataDir,
    NODE_ENV: production ? 'production' : 'development',
  };
  delete environment.RANKINGS_ADMIN_USERNAME;
  delete environment.RANKINGS_ADMIN_PASSWORD;
  if (options.username !== null) environment.RANKINGS_ADMIN_USERNAME = options.username ?? username;
  if (options.password !== null) environment.RANKINGS_ADMIN_PASSWORD = options.password ?? password;
  server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: ROOT,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', (value) => {
    output += String(value);
  });
  server.stderr?.on('data', (value) => {
    output += String(value);
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) return;
    } catch {
      /* Wait for the test server. */
    }
    if (server.exitCode !== null) throw new Error(`Server exited: ${output}`);
    await pause(50);
  }
  throw new Error(`Server did not start: ${output}`);
}
async function stop(): Promise<void> {
  if (!server || server.exitCode !== null) return;
  const active = server;
  await new Promise<void>((resolve) => {
    active.once('exit', () => resolve());
    active.kill('SIGTERM');
  });
  server = null;
}
async function request(
  route = '',
  method = 'GET',
  body?: unknown,
  options: {
    authenticated?: boolean;
    origin?: string | null;
    forwarded?: string;
    raw?: boolean;
  } = {},
): Promise<{ response: Response; value: Payload }> {
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers.origin = production ? `https://127.0.0.1:${port}` : url;
  if (options.origin === null) delete headers.origin;
  else if (options.origin !== undefined) headers.origin = options.origin;
  if (options.authenticated && cookie) headers.cookie = cookie;
  if (options.forwarded) headers['x-forwarded-for'] = options.forwarded;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${endpoint}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : options.raw ? String(body) : JSON.stringify(body),
  });
  const value = (await response.json()) as Payload;
  return { response, value };
}
function remember(response: Response): void {
  const set = response.headers.get('set-cookie');
  assert.ok(set, 'Owner authentication sets a cookie.');
  assert.match(set, /HttpOnly/i);
  assert.match(set, /SameSite=Strict/i);
  assert.match(set, /Path=\/api\/rankings/i);
  cookie = set.split(';')[0];
}

try {
  // Old disk credentials can no longer grant access, and are preserved rather than deleted.
  const legacyFile = path.join(dataDir, 'rankings-admin.json');
  const legacyContents = '{"obsolete":"credentials are no longer read"}';
  writeFileSync(legacyFile, legacyContents);
  for (const configuration of [
    { username: null, password: null },
    { username: null },
    { password: null },
    { username: '' },
    { password: 'short' },
  ]) {
    await start(configuration);
    const publicResult = await request();
    assert.equal(publicResult.response.status, 200);
    assert.deepEqual(publicResult.value.data, emptyRankings());
    assert.deepEqual(publicResult.value.access, {
      authenticated: false,
      configured: false,
      canSetup: false,
    });
    assert.equal((await request('/setup', 'POST', { username, password })).response.status, 403);
    assert.equal((await request('/login', 'POST', { username, password })).response.status, 409);
    assert.equal((await request('', 'PUT', emptyRankings())).response.status, 401);
    assert.equal(readFileSync(legacyFile, 'utf8'), legacyContents);
    await stop();
  }
  rmSync(legacyFile);
  await start();
  let result = await request();
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.value.access, {
    authenticated: false,
    configured: true,
    canSetup: false,
  });
  const publicAccess = await request('/access');
  assert.equal(publicAccess.response.status, 200);
  assert.deepEqual(publicAccess.value, { access: result.value.access });
  assert.equal(publicAccess.response.headers.get('cache-control'), 'no-store');
  assert.equal((await request('/setup', 'POST', { username, password })).response.status, 403);
  assert.equal(
    (await request('/login', 'POST', { username, password }, { origin: null })).response.status,
    403,
  );
  assert.equal(
    (
      await request(
        '/login',
        'POST',
        { username, password },
        { origin: 'https://untrusted.example' },
      )
    ).response.status,
    403,
  );
  assert.equal((await request('/login', 'POST', '{oops', { raw: true })).response.status, 400);
  const wrongName = await request('/login', 'POST', { username: 'wrong-owner', password });
  const wrongPassword = await request('/login', 'POST', { username, password: 'wrong-password' });
  assert.equal(wrongName.response.status, 401);
  assert.equal(wrongPassword.response.status, 401);
  assert.equal(wrongName.value.error, wrongPassword.value.error);
  assert.equal((await request('/login', 'POST', { password })).response.status, 401);
  result = await request(
    '/login',
    'POST',
    { username, password },
    { origin: 'http://localhost:5173' },
  );
  assert.equal(result.response.status, 200, 'Vite local development origin can sign in.');
  remember(result.response);
  assert.equal(result.value.access.authenticated, true);
  assert.equal(
    (await request('/access', 'GET', undefined, { authenticated: true })).value.access
      .authenticated,
    true,
  );
  assert.equal(
    (await request('', 'GET', undefined, { authenticated: true })).value.access.authenticated,
    true,
  );
  assert.equal((await request()).value.access.authenticated, false);
  assert.equal(existsSync(legacyFile), false, 'No credential file is written.');
  assert.ok(!JSON.stringify(result.value).includes(password));
  assert.ok(!JSON.stringify(result.value).includes(username));

  const ledger: RankingsData = {
    version: 1,
    revision: 0,
    players: [
      { id: 'alice', name: 'Alice' },
      { id: 'bob', name: 'Bob' },
    ],
    games: [
      {
        id: 'first-game',
        date: '2026-10-01',
        notes: 'Our first recorded match',
        results: [
          {
            playerId: 'alice',
            breakdown: {
              ...emptyBreakdown(),
              settlements: 2,
              cities: 2,
              longestRoad: true,
              victoryCards: 2,
            },
          },
          {
            playerId: 'bob',
            breakdown: { ...emptyBreakdown(), settlements: 3, cities: 1, largestArmy: true },
          },
        ],
      },
    ],
  };
  assert.equal(
    (await request('', 'PUT', ledger, { authenticated: true, origin: 'https://untrusted.example' }))
      .response.status,
    403,
  );
  result = await request('', 'PUT', ledger, { authenticated: true });
  assert.equal(result.response.status, 200);
  assert.equal(result.value.data.revision, 1);
  assert.deepEqual(result.value.data.games, ledger.games);
  assert.deepEqual(
    (await request()).value.data,
    result.value.data,
    'Public readers see the shared ledger.',
  );
  assert.equal(statSync(path.join(dataDir, 'rankings.json')).mode & 0o777, 0o600);
  assert.equal((await request('', 'PUT', ledger, { authenticated: true })).response.status, 409);
  ledger.revision = 1;
  const invalid = structuredClone(ledger);
  invalid.games[0].results[0].breakdown.cities = 9;
  assert.equal((await request('', 'PUT', invalid, { authenticated: true })).response.status, 400);
  assert.equal((await request()).value.data.revision, 1);
  ledger.players[1].name = 'Robert';
  ledger.games[0].date = '2026-09-30';
  ledger.games[0].results[1].breakdown.victoryCards = 1;
  result = await request('', 'PUT', ledger, { authenticated: true });
  assert.equal(result.response.status, 200);
  assert.equal(result.value.data.revision, 2);
  assert.equal(result.value.data.games[0].results[1].breakdown.victoryCards, 1);
  console.info(
    'Rankings CRUD, VP breakdowns, public access, private credentials, and revision conflicts passed.',
  );

  const oldCookie = cookie;
  await stop();
  await start();
  result = await request('', 'GET', undefined, { authenticated: true });
  assert.equal(result.value.data.revision, 2);
  assert.equal(result.value.data.players[1].name, 'Robert');
  assert.equal(result.value.access.configured, true);
  assert.equal(
    result.value.access.authenticated,
    false,
    'Owner sessions expire when the server restarts.',
  );
  assert.equal(
    (await request('', 'PUT', result.value.data, { authenticated: true })).response.status,
    401,
  );
  assert.equal(
    (await request('/login', 'POST', { username, password: 'incorrect-password' })).response.status,
    401,
  );
  result = await request('/login', 'POST', { username, password });
  assert.equal(result.response.status, 200);
  remember(result.response);
  assert.notEqual(cookie, oldCookie);
  const deletion = structuredClone(result.value.data);
  deletion.games = [];
  deletion.players = [];
  result = await request('', 'PUT', deletion, { authenticated: true });
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.value.data.games, []);
  assert.equal(result.value.data.revision, 3);
  result = await request('/logout', 'POST', {}, { authenticated: true });
  assert.equal(result.value.access.authenticated, false);
  assert.equal(
    (await request('/access', 'GET', undefined, { authenticated: true })).value.access
      .authenticated,
    false,
  );
  assert.equal((await request('', 'PUT', deletion, { authenticated: true })).response.status, 401);
  for (let i = 0; i < 10; i++)
    assert.equal(
      (await request('/login', 'POST', { username, password: 'incorrect-password' })).response
        .status,
      401,
    );
  assert.equal((await request('/login', 'POST', { username, password })).response.status, 429);
  console.info(
    'Rankings survive restarts; revoked sessions, wrong passwords, deletion, and login rate limits passed.',
  );

  await stop();
  await start({ production: true, username: null, password: null });
  result = await request();
  assert.equal(result.value.access.canSetup, false);
  assert.equal(result.value.access.configured, false);
  assert.equal(
    (await request('/setup', 'POST', { password })).response.status,
    403,
    'A hosted visitor cannot claim the owner role.',
  );
  await stop();
  await start({ production: true, password: productionPassword });
  result = await request('/login', 'POST', { username, password: productionPassword });
  assert.equal(result.response.status, 200);
  remember(result.response);
  assert.match(result.response.headers.get('set-cookie')!, /Secure/i);
  assert.equal(
    (await request('/login', 'POST', { username, password: productionPassword }, { origin: url }))
      .response.status,
    403,
  );
  assert.equal(
    existsSync(path.join(dataDir, 'rankings-admin.json')),
    false,
    'Environment passwords are not copied to disk.',
  );
  assert.ok(!output.includes(productionPassword), 'Passwords are not logged.');
  console.info(
    'Production setup lockout, environment credentials, HTTPS origin, and secure cookies passed.',
  );

  await stop();
  const corrupt = '{ "broken": true ';
  writeFileSync(path.join(dataDir, 'rankings.json'), corrupt);
  await start();
  assert.equal((await request()).response.status, 503);
  assert.equal((await request('/setup', 'POST', { password })).response.status, 403);
  assert.equal(
    readFileSync(path.join(dataDir, 'rankings.json'), 'utf8'),
    corrupt,
    'A corrupt ledger is never overwritten.',
  );
  assert.equal(
    (await fetch(`${url}/api/health`)).status,
    200,
    'The game server still runs if the rankings file needs recovery.',
  );
  console.info('Corrupt ledger preservation passed. All rankings integration checks passed.');
} catch (error) {
  console.error(output);
  throw error;
} finally {
  await stop();
  rmSync(dataDir, { recursive: true, force: true });
}
