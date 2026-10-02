import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Auth } from 'firebase/auth';
import type { Firestore } from 'firebase/firestore';

const sdk = vi.hoisted(() => ({
  getDocFromServer: vi.fn(),
  getDocsFromServer: vi.fn(),
  runTransaction: vi.fn(),
  onAuthStateChanged: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  signOut: vi.fn(),
  getFirebaseServices: vi.fn(),
  unsubscribe: vi.fn(),
}));
vi.mock('firebase/auth', () => ({
  onAuthStateChanged: sdk.onAuthStateChanged,
  signInWithEmailAndPassword: sdk.signInWithEmailAndPassword,
  signOut: sdk.signOut,
}));
vi.mock('firebase/firestore', () => ({
  doc: (base: { path?: string }, ...parts: string[]) => ({
    path: [base.path, ...parts].filter(Boolean).join('/'),
  }),
  collection: (base: { path?: string }, ...parts: string[]) => ({
    path: [base.path, ...parts].filter(Boolean).join('/'),
  }),
  limit: (maximum: number) => maximum,
  query: (base: { path: string }, maximum: number) => ({ ...base, maximum }),
  getDocFromServer: sdk.getDocFromServer,
  getDocsFromServer: sdk.getDocsFromServer,
  runTransaction: sdk.runTransaction,
}));
vi.mock('../firebase', () => ({ getFirebaseServices: sdk.getFirebaseServices }));
import { createFirebaseRankingsClient } from './firebase-client';
import { emptyRankings, emptyBreakdown, type RankingsData } from './model';

const ROOT = 'catan/rankings';
const GATE = `${ROOT}/access/owner`;
let database: Map<string, unknown>;
let auth: { currentUser: { uid: string } | null; authStateReady: ReturnType<typeof vi.fn> };
let client: ReturnType<typeof createFirebaseRankingsClient>;
let authChanged: () => void;
let reads: string[];
let transactionGet: ReturnType<typeof vi.fn>;
let transactionSet: ReturnType<typeof vi.fn>;
let transactionDelete: ReturnType<typeof vi.fn>;
let beforeTransaction: (() => void) | undefined;
const copy = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
function document(path: string, data = database.get(path)) {
  const value = copy(data);
  return {
    id: path.split('/').at(-1),
    exists: () => value !== undefined,
    data: () => copy(value),
    metadata: { fromCache: false },
  };
}
function metadata(data: RankingsData) {
  return {
    schema: 'catan-rankings-v1',
    version: data.version,
    revision: data.revision,
    playerIds: data.players.map((player) => player.id),
    gameIds: data.games.map((game) => game.id),
  };
}
function seed(data: RankingsData) {
  database.clear();
  database.set(ROOT, metadata(data));
  for (const player of data.players) database.set(`${ROOT}/players/${player.id}`, copy(player));
  for (const game of data.games) database.set(`${ROOT}/games/${game.id}`, copy(game));
}
function fixture(): RankingsData {
  return {
    version: 1,
    revision: 3,
    players: [
      { id: 'a', name: 'Ada' },
      { id: 'b', name: 'Ben' },
    ],
    games: [
      {
        id: 'game-1',
        date: '2026-10-02',
        notes: 'First match',
        results: [
          { playerId: 'a', breakdown: { ...emptyBreakdown(), cities: 3, settlements: 4 } },
          { playerId: 'b', breakdown: { ...emptyBreakdown(), cities: 2, settlements: 2 } },
        ],
      },
    ],
  };
}
const owner = () => {
  auth.currentUser = { uid: 'owner-uid' };
};
const codeError = (code: string) =>
  Object.assign(new Error('SECRET_PRIVATE_FIREBASE_RESPONSE'), { code });

beforeEach(() => {
  vi.resetAllMocks();
  database = new Map();
  reads = [];
  beforeTransaction = undefined;
  auth = { currentUser: null, authStateReady: vi.fn().mockResolvedValue(undefined) };
  sdk.getDocFromServer.mockImplementation(async ({ path }: { path: string }) => {
    reads.push(path);
    if (path === GATE && auth.currentUser?.uid !== 'owner-uid')
      throw codeError('permission-denied');
    return document(path);
  });
  sdk.getDocsFromServer.mockImplementation(
    async ({ path, maximum }: { path: string; maximum: number }) => {
      reads.push(path);
      const docs = [...database.keys()]
        .filter((key) => key.startsWith(`${path}/`) && key.split('/').length === 4)
        .sort()
        .slice(0, maximum)
        .map((key) => document(key));
      return { docs, empty: !docs.length };
    },
  );
  transactionGet = vi.fn(async ({ path }: { path: string }) => {
    reads.push(path);
    return document(path);
  });
  transactionSet = vi.fn();
  transactionDelete = vi.fn();
  sdk.runTransaction.mockImplementation(async (_db, body) => {
    beforeTransaction?.();
    const value = await body({
      get: transactionGet,
      set: transactionSet,
      delete: transactionDelete,
    });
    for (const [{ path }, data] of transactionSet.mock.calls) database.set(path, copy(data));
    for (const [{ path }] of transactionDelete.mock.calls) database.delete(path);
    return value;
  });
  sdk.signInWithEmailAndPassword.mockImplementation(async (_auth, email) => {
    auth.currentUser = { uid: email === 'owner@example.invalid' ? 'owner-uid' : 'other-uid' };
    return { user: auth.currentUser };
  });
  sdk.signOut.mockImplementation(async () => {
    auth.currentUser = null;
  });
  sdk.onAuthStateChanged.mockImplementation((_auth, callback) => {
    authChanged = callback;
    return sdk.unsubscribe;
  });
  client = createFirebaseRankingsClient({ db: {} as Firestore, auth: auth as unknown as Auth });
});

describe('public browser rankings', () => {
  it('loads an existing ledger in index order using only server reads of public paths', async () => {
    const data = fixture();
    data.players.reverse();
    seed(data);
    database.set(`${ROOT}/ownerSessions/private-session`, { secret: 'must-not-be-read' });
    database.set(`${ROOT}/onlineRooms/private-room`, { secret: 'hidden-cards' });
    expect(await client.loadRankings()).toEqual({
      data,
      access: { authenticated: false, configured: true, canSetup: false },
    });
    expect(reads).toEqual([ROOT, `${ROOT}/players`, `${ROOT}/games`, ROOT]);
    expect(sdk.getDocsFromServer.mock.calls.map(([ref]) => ref.maximum)).toEqual([501, 2001]);
  });
  it('treats a completely unused ledger as empty without creating records', async () => {
    expect((await client.loadRankings()).data).toEqual(emptyRankings());
    expect(sdk.runTransaction).not.toHaveBeenCalled();
    expect(database.size).toBe(0);
  });
  it('retries mixed revisions instead of returning mismatched metadata and records', async () => {
    const first = fixture();
    seed(first);
    let rootReads = 0;
    sdk.getDocFromServer.mockImplementation(async ({ path }) => {
      if (path === ROOT && ++rootReads === 2) {
        const newer = fixture();
        newer.revision += 1;
        newer.players[0].name = 'Ada updated';
        seed(newer);
      }
      return document(path);
    });
    const result = await client.loadRankings();
    expect(result.data.revision).toBe(4);
    expect(result.data.players[0].name).toBe('Ada updated');
    expect(rootReads).toBe(4);
  });
  it('reports a conflict after repeated concurrent writes', async () => {
    const data = fixture();
    seed(data);
    sdk.getDocFromServer.mockImplementation(async ({ path }) => {
      if (path === ROOT) {
        data.revision += 1;
        seed(data);
      }
      return document(path);
    });
    await expect(client.loadRankings()).rejects.toMatchObject({ status: 409 });
    expect(sdk.getDocsFromServer).toHaveBeenCalledTimes(6);
  });
  it.each([
    () => database.delete(ROOT),
    () => database.delete(`${ROOT}/players/a`),
    () => database.set(`${ROOT}/players/orphan`, { id: 'orphan', name: 'Unknown' }),
    () => database.set(`${ROOT}/players/a`, { id: 'wrong-id', name: 'Ada' }),
    () => database.set(`${ROOT}/players/b`, { id: 'b', name: 'Ada' }),
    () => database.set(ROOT, { ...metadata(fixture()), schema: 'unrelated-data' }),
    () => database.set(ROOT, { ...metadata(fixture()), playerIds: ['a', 'a'] }),
    () => database.set(`${ROOT}/games/game-1`, { ...fixture().games[0], results: [] }),
  ])('fails closed for corrupt, incomplete, or orphaned records (%#)', async (corrupt) => {
    seed(fixture());
    corrupt();
    const before = copy([...database]);
    await expect(client.loadRankings()).rejects.toMatchObject({ status: 502 });
    owner();
    await expect(client.saveRankings(fixture())).rejects.toMatchObject({ status: 502 });
    expect([...database]).toEqual(before);
    expect(sdk.runTransaction).not.toHaveBeenCalled();
  });
  it('does not substitute offline cache or an empty ledger after a failed read', async () => {
    seed(fixture());
    sdk.getDocsFromServer.mockRejectedValueOnce(codeError('unavailable'));
    await expect(client.loadRankings()).rejects.toMatchObject({ status: 0 });
    expect(sdk.runTransaction).not.toHaveBeenCalled();
  });
});

describe('Firebase owner authentication', () => {
  it('waits for persisted Auth state before checking owner-only gate access', async () => {
    owner();
    const result = await client.readAccess();
    expect(auth.authStateReady).toHaveBeenCalled();
    expect(result.authenticated).toBe(true);
    expect(reads).toEqual([GATE]);
    expect(database.has(GATE)).toBe(false);
  });
  it('signs in using entered email/password and checks owner Rules even if the gate does not exist', async () => {
    seed(fixture());
    const result = await client.loginRankings(' owner@example.invalid ', 'secret-password');
    expect(sdk.signInWithEmailAndPassword).toHaveBeenCalledWith(
      auth,
      'owner@example.invalid',
      'secret-password',
    );
    expect(result.access.authenticated).toBe(true);
    expect(result.data).toEqual(fixture());
    expect(database.has(GATE)).toBe(false);
    expect(transactionSet).not.toHaveBeenCalled();
  });
  it('signs out a valid Firebase user who is not the owner and returns a generic login error', async () => {
    await expect(
      client.loginRankings('other@example.invalid', 'private-password'),
    ).rejects.toMatchObject({
      status: 401,
      message: 'The email or password is incorrect, or this account cannot edit rankings.',
    });
    expect(sdk.signOut).toHaveBeenCalledWith(auth);
    expect(auth.currentUser).toBeNull();
    expect(sdk.getDocsFromServer).not.toHaveBeenCalled();
  });
  it.each(['auth/invalid-credential', 'auth/user-disabled', 'auth/user-not-found'])(
    'sanitizes %s without revealing account details',
    async (code) => {
      sdk.signInWithEmailAndPassword.mockRejectedValueOnce(codeError(code));
      await expect(
        client.loginRankings('owner@example.invalid', 'private-password'),
      ).rejects.toMatchObject({
        status: 401,
        message: 'The email or password is incorrect, or this account cannot edit rankings.',
      });
    },
  );
  it('shows a connection failure if Firebase Auth cannot be reached', async () => {
    sdk.signInWithEmailAndPassword.mockRejectedValueOnce(codeError('auth/network-request-failed'));
    await expect(
      client.loginRankings('owner@example.invalid', 'private-password'),
    ).rejects.toMatchObject({ status: 0 });
  });
  it('logs out while keeping the public rankings visible', async () => {
    seed(fixture());
    owner();
    const result = await client.logoutRankings();
    expect(auth.currentUser).toBeNull();
    expect(result.access.authenticated).toBe(false);
    expect(result.data).toEqual(fixture());
  });
  it('does not allow anonymous or nonowner saves', async () => {
    seed(fixture());
    await expect(client.saveRankings(fixture())).rejects.toMatchObject({ status: 401 });
    auth.currentUser = { uid: 'other-uid' };
    await expect(client.saveRankings(fixture())).rejects.toMatchObject({ status: 401 });
    expect(sdk.runTransaction).not.toHaveBeenCalled();
  });
  it('ignores a late owner check after logout and after unsubscribe', async () => {
    owner();
    let resolve!: (value: unknown) => void;
    sdk.getDocFromServer.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const listener = vi.fn();
    const stop = client.watchRankingsAccess(listener);
    authChanged();
    await vi.waitFor(() => expect(sdk.getDocFromServer).toHaveBeenCalled());
    auth.currentUser = null;
    authChanged();
    await vi.waitFor(() =>
      expect(listener).toHaveBeenCalledWith({
        authenticated: false,
        configured: true,
        canSetup: false,
      }),
    );
    resolve(document(GATE));
    await Promise.resolve();
    await Promise.resolve();
    expect(listener.mock.calls.every(([access]) => access.authenticated === false)).toBe(true);
    stop();
    expect(sdk.unsubscribe).toHaveBeenCalledOnce();
    const count = listener.mock.calls.length;
    authChanged();
    await Promise.resolve();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(count);
  });
});

describe('atomic browser ledger updates', () => {
  it('creates a ledger with the existing metadata/player/game schema', async () => {
    owner();
    const next = fixture();
    next.revision = 0;
    const reply = await client.saveRankings(next);
    expect(reply.data.revision).toBe(1);
    expect(database.get(ROOT)).toEqual(metadata({ ...next, revision: 1 }));
    expect(database.get(`${ROOT}/games/game-1`)).toEqual(next.games[0]);
    expect(transactionSet).toHaveBeenCalledTimes(4);
  });
  it('writes only changed records and metadata, preserving unrelated games and private subcollections', async () => {
    const current = fixture();
    seed(current);
    owner();
    database.set(`${ROOT}/onlineRooms/room`, { secret: 'hidden-cards' });
    const next = fixture();
    next.players[0].name = 'Ada renamed';
    const reply = await client.saveRankings(next);
    expect(reply.data.revision).toBe(4);
    expect(transactionSet.mock.calls.map(([ref]) => ref.path)).toEqual([`${ROOT}/players/a`, ROOT]);
    expect(transactionGet.mock.calls.map(([ref]) => ref.path)).toEqual([ROOT, `${ROOT}/players/a`]);
    expect(transactionDelete).not.toHaveBeenCalled();
    expect(database.get(`${ROOT}/onlineRooms/room`)).toEqual({ secret: 'hidden-cards' });
  });
  it('deletes only records explicitly removed from the validated index', async () => {
    seed(fixture());
    owner();
    const next = fixture();
    next.games = [];
    await client.saveRankings(next);
    expect(transactionDelete.mock.calls.map(([ref]) => ref.path)).toEqual([`${ROOT}/games/game-1`]);
    expect(database.get(ROOT)).toEqual(metadata({ ...next, revision: 4 }));
    expect(database.has(`${ROOT}/players/a`)).toBe(true);
  });
  it('rejects stale revisions before any transaction writes', async () => {
    seed(fixture());
    owner();
    const next = fixture();
    next.revision = 2;
    await expect(client.saveRankings(next)).rejects.toMatchObject({ status: 409 });
    expect(sdk.runTransaction).not.toHaveBeenCalled();
  });
  it('rejects another writer committing between preflight and the transaction', async () => {
    seed(fixture());
    owner();
    beforeTransaction = () => {
      const changed = fixture();
      changed.revision += 1;
      changed.players[0].name = 'Other editor';
      seed(changed);
    };
    const next = fixture();
    next.players[0].name = 'My edit';
    await expect(client.saveRankings(next)).rejects.toMatchObject({ status: 409 });
    expect(transactionSet).not.toHaveBeenCalled();
    expect((database.get(`${ROOT}/players/a`) as { name: string }).name).toBe('Other editor');
  });
  it('recognizes a Rules-denied stale commit only after rechecking owner access and metadata', async () => {
    seed(fixture());
    owner();
    sdk.runTransaction.mockImplementationOnce(async () => {
      const newer = fixture();
      newer.revision += 1;
      newer.players[0].name = 'Other editor';
      seed(newer);
      throw codeError('permission-denied');
    });
    const next = fixture();
    next.players[0].name = 'My edit';
    await expect(client.saveRankings(next)).rejects.toMatchObject({ status: 409 });
    expect(reads.filter((path) => path === GATE)).toHaveLength(2);
    expect(transactionSet).not.toHaveBeenCalled();
  });
  it('preserves access denial when permissions are revoked even if metadata also changed', async () => {
    seed(fixture());
    owner();
    sdk.runTransaction.mockImplementationOnce(async () => {
      const newer = fixture();
      newer.revision += 1;
      seed(newer);
      sdk.getDocFromServer.mockImplementation(async ({ path }) => {
        if (path === GATE) throw codeError('permission-denied');
        return document(path);
      });
      throw codeError('permission-denied');
    });
    await expect(client.saveRankings(fixture())).rejects.toMatchObject({ status: 401 });
    expect(transactionSet).not.toHaveBeenCalled();
  });
  it('does not overwrite a changed document even if another tool forgot the revision', async () => {
    seed(fixture());
    owner();
    beforeTransaction = () => database.set(`${ROOT}/players/a`, { id: 'a', name: 'External edit' });
    const next = fixture();
    next.players[0].name = 'My edit';
    await expect(client.saveRankings(next)).rejects.toMatchObject({ status: 409 });
    expect(transactionSet).not.toHaveBeenCalled();
  });
  it('does not overwrite a new unindexed document inserted after the preflight query', async () => {
    seed(fixture());
    owner();
    beforeTransaction = () =>
      database.set(`${ROOT}/players/new-player`, { id: 'new-player', name: 'Unexpected record' });
    const next = fixture();
    next.players.push({ id: 'new-player', name: 'My new player' });
    await expect(client.saveRankings(next)).rejects.toMatchObject({ status: 409 });
    expect(transactionSet).not.toHaveBeenCalled();
  });
  it('stops a pending save if the owner signs out before writes are queued', async () => {
    seed(fixture());
    owner();
    beforeTransaction = () => {
      auth.currentUser = null;
    };
    const next = fixture();
    next.players[0].name = 'Edit';
    await expect(client.saveRankings(next)).rejects.toMatchObject({ status: 401 });
    expect(transactionSet).not.toHaveBeenCalled();
  });
  it('validates full VP breakdowns before contacting Firestore', async () => {
    owner();
    const next = fixture();
    next.games[0].results[0].breakdown.settlements = 10;
    await expect(client.saveRankings(next)).rejects.toMatchObject({ status: 400 });
    expect(reads).toEqual([]);
    expect(sdk.runTransaction).not.toHaveBeenCalled();
  });
  it('rejects more than 449 changed records before a transaction', async () => {
    owner();
    const next = emptyRankings();
    next.players = Array.from({ length: 450 }, (_, i) => ({ id: `p${i}`, name: `Player ${i}` }));
    await expect(client.saveRankings(next)).rejects.toMatchObject({ status: 400 });
    expect(sdk.runTransaction).not.toHaveBeenCalled();
    expect(database.size).toBe(0);
  });
  it('permits exactly 449 changed records plus metadata', async () => {
    owner();
    const next = emptyRankings();
    next.players = Array.from({ length: 449 }, (_, i) => ({ id: `p${i}`, name: `Player ${i}` }));
    expect((await client.saveRankings(next)).data.revision).toBe(1);
    expect(transactionSet).toHaveBeenCalledTimes(450);
  });
  it('rejects oversized UTF-8 updates including previous record/index costs', async () => {
    const current = fixture();
    current.games = Array.from({ length: 449 }, (_, i) => ({
      ...copy(current.games[0]),
      id: `g${i}`,
      notes: '界'.repeat(2000),
    }));
    seed(current);
    owner();
    const next = copy(current);
    for (const game of next.games) game.notes = '語'.repeat(2000);
    await expect(client.saveRankings(next)).rejects.toMatchObject({
      status: 400,
      message:
        'This update is too large for one Firestore transaction. Save fewer changes at a time.',
    });
    expect(sdk.runTransaction).not.toHaveBeenCalled();
  });
  it('does not wrap a revision beyond the safe integer limit', async () => {
    const current = fixture();
    current.revision = Number.MAX_SAFE_INTEGER;
    seed(current);
    owner();
    await expect(client.saveRankings(current)).rejects.toMatchObject({ status: 400 });
    expect(sdk.runTransaction).not.toHaveBeenCalled();
  });
  it.each([
    ['unavailable', 0],
    ['permission-denied', 401],
    ['aborted', 409],
  ])('sanitizes commit %s failures (%#)', async (code, status) => {
    seed(fixture());
    owner();
    sdk.runTransaction.mockRejectedValueOnce(codeError(code as string));
    const error = await client.saveRankings(fixture()).catch((value: unknown) => value);
    expect(error).toMatchObject({ status });
    expect((error as Error).message).not.toContain('SECRET_PRIVATE');
    expect((error as Error).cause).toBeUndefined();
  });
});
