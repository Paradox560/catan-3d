import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Firestore } from 'firebase/firestore';
const sdk = vi.hoisted(() => ({
  getDocFromServer: vi.fn(),
  getDocsFromServer: vi.fn(),
  getFirebaseServices: vi.fn(),
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
  // Intentionally no browser write or Firebase Authentication APIs.
}));
vi.mock('../firebase', () => ({ getFirebaseServices: sdk.getFirebaseServices }));
import { createFirebaseRankingsClient, type RankingsOwnerClient } from './firebase-client';
import { emptyRankings, emptyBreakdown, type RankingsData } from './model';
import { RankingsError, type RankingsAccess, type RankingsReply } from './types';
const ROOT = 'catan/rankings';
const visitor: RankingsAccess = { authenticated: false, configured: true, canSetup: false };
const ownerAccess: RankingsAccess = { ...visitor, authenticated: true };
const unavailable: RankingsAccess = { authenticated: false, configured: false, canSetup: false };
let database: Map<string, unknown>;
let reads: string[];
let client: ReturnType<typeof createFirebaseRankingsClient>;
let owner: { [Key in keyof RankingsOwnerClient]: Mock<RankingsOwnerClient[Key]> };
const copy = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
function document(path: string, data = database.get(path)) {
  const value = copy(data);
  return { id: path.split('/').at(-1), exists: () => value !== undefined, data: () => copy(value) };
}
function metadata(data: RankingsData) {
  return {
    schema: 'catan-rankings-v1',
    version: data.version,
    revision: data.revision,
    playerIds: data.players.map((p) => p.id),
    gameIds: data.games.map((g) => g.id),
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
const reply = (access = ownerAccess): RankingsReply => ({ data: fixture(), access });
const failure = (code: string) => Object.assign(new Error('PRIVATE_FIREBASE_RESPONSE'), { code });
beforeEach(() => {
  vi.resetAllMocks();
  database = new Map();
  reads = [];
  sdk.getDocFromServer.mockImplementation(async ({ path }) => {
    reads.push(path);
    return document(path);
  });
  sdk.getDocsFromServer.mockImplementation(async ({ path, maximum }) => {
    reads.push(path);
    const docs = [...database.keys()]
      .filter((key) => key.startsWith(`${path}/`) && key.split('/').length === 4)
      .sort()
      .slice(0, maximum)
      .map((key) => document(key));
    return { docs, empty: docs.length === 0 };
  });
  owner = {
    loadRankingsAccess: vi.fn().mockResolvedValue(visitor),
    loginRankings: vi.fn().mockResolvedValue(reply()),
    logoutRankings: vi.fn().mockResolvedValue(reply(visitor)),
    saveRankings: vi.fn().mockResolvedValue(reply()),
  };
  client = createFirebaseRankingsClient({ db: {} as Firestore }, owner);
});

describe('public Firestore rankings reads', () => {
  it('reads only exact public paths in metadata order and gets owner status from the server', async () => {
    const data = fixture();
    data.players.reverse();
    seed(data);
    database.set(`${ROOT}/ownerSessions/private`, { secret: 'private' });
    database.set(`${ROOT}/onlineRooms/private`, { secret: 'hidden hands' });
    expect(await client.loadRankings()).toEqual({ data, access: visitor });
    expect(reads).toEqual([ROOT, `${ROOT}/players`, `${ROOT}/games`, ROOT]);
    expect(sdk.getDocsFromServer.mock.calls.map(([ref]) => ref.maximum)).toEqual([501, 2001]);
    expect(owner.loadRankingsAccess).toHaveBeenCalledOnce();
    expect(owner.saveRankings).not.toHaveBeenCalled();
  });
  it('returns an unused ledger without creating any document', async () => {
    expect((await client.loadRankings()).data).toEqual(emptyRankings());
    expect(database.size).toBe(0);
    expect(owner.saveRankings).not.toHaveBeenCalled();
  });
  it('keeps public records readable when the owner API is unavailable', async () => {
    seed(fixture());
    owner.loadRankingsAccess.mockRejectedValueOnce(new RankingsError('Unavailable', 503));
    expect(await client.loadRankings()).toEqual({ data: fixture(), access: unavailable });
  });
  it('retries overlapping ledger revisions rather than mixing old indexes and new records', async () => {
    const data = fixture();
    seed(data);
    let rootReads = 0;
    sdk.getDocFromServer.mockImplementation(async ({ path }) => {
      if (path === ROOT && ++rootReads === 2) {
        data.revision += 1;
        data.players[0].name = 'New name';
        seed(data);
      }
      return document(path);
    });
    expect((await client.loadRankings()).data).toEqual(data);
    expect(rootReads).toBe(4);
  });
  it('returns409 after three changing snapshots', async () => {
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
  ])(
    'preserves corrupt/incomplete/orphaned records and refuses to render a false ledger (%#)',
    async (corrupt) => {
      seed(fixture());
      corrupt();
      const before = copy([...database]);
      await expect(client.loadRankings()).rejects.toMatchObject({ status: 502 });
      expect([...database]).toEqual(before);
      expect(owner.saveRankings).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['permission-denied', 403],
    ['unavailable', 0],
  ])('sanitizes %s without falling back to the owner API ledger (%#)', async (code, status) => {
    sdk.getDocsFromServer.mockRejectedValueOnce(failure(code as string));
    const error = await client.loadRankings().catch((value: unknown) => value);
    expect(error).toMatchObject({ status });
    expect((error as Error).message).not.toContain('PRIVATE_FIREBASE_RESPONSE');
    expect(owner.loginRankings).not.toHaveBeenCalled();
    expect(owner.saveRankings).not.toHaveBeenCalled();
  });
});

describe('server-only owner actions', () => {
  it('passes a username and password only to the same-origin owner API', async () => {
    expect(await client.loginRankings('keeper', 'password entered by owner')).toEqual(reply());
    expect(owner.loginRankings).toHaveBeenCalledWith('keeper', 'password entered by owner');
    expect(reads).toEqual([]);
  });
  it('uses the server logout response without reading Firestore private paths', async () => {
    expect(await client.logoutRankings()).toEqual(reply(visitor));
    expect(owner.logoutRankings).toHaveBeenCalledOnce();
    expect(reads).toEqual([]);
  });
  it('saves validated records only through the server; backend determines owner permission and revision', async () => {
    const saved = { ...fixture(), revision: 4 };
    owner.saveRankings.mockResolvedValueOnce({ data: saved, access: ownerAccess });
    expect((await client.saveRankings(fixture())).data.revision).toBe(4);
    expect(owner.saveRankings).toHaveBeenCalledWith(fixture());
    expect(reads).toEqual([]);
    expect(database.size).toBe(0);
  });
  it('rejects invalid VP input before contacting the server', async () => {
    const data = fixture();
    data.games[0].results[0].breakdown.cities = 10;
    await expect(client.saveRankings(data)).rejects.toMatchObject({ status: 400 });
    expect(owner.saveRankings).not.toHaveBeenCalled();
  });
  it.each([401, 409, 429, 503])(
    'preserves server status%d and message for existing UI recovery',
    async (status) => {
      const error = new RankingsError('Server provided safe explanation', status);
      owner.saveRankings.mockRejectedValueOnce(error);
      await expect(client.saveRankings(fixture())).rejects.toBe(error);
    },
  );
  it('locks editing when the server expires the cookie session', async () => {
    owner.loadRankingsAccess.mockResolvedValue(ownerAccess);
    const listener = vi.fn();
    const stop = client.watchRankingsAccess(listener);
    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(ownerAccess));
    owner.saveRankings.mockRejectedValueOnce(new RankingsError('Sign in again', 401));
    await expect(client.saveRankings(fixture())).rejects.toMatchObject({ status: 401 });
    expect(listener).toHaveBeenLastCalledWith(visitor);
    stop();
  });
  it('combines simultaneous status requests without querying the ledger', async () => {
    expect(await Promise.all([client.readAccess(), client.readAccess()])).toEqual([
      visitor,
      visitor,
    ]);
    expect(owner.loadRankingsAccess).toHaveBeenCalledOnce();
    expect(reads).toEqual([]);
  });
  it('ignores an older status response after sign-in succeeds', async () => {
    let finish!: (value: RankingsAccess) => void;
    owner.loadRankingsAccess.mockReturnValueOnce(
      new Promise((done) => {
        finish = done;
      }),
    );
    const listener = vi.fn();
    const stop = client.watchRankingsAccess(listener);
    await client.loginRankings('keeper', 'password');
    finish(visitor);
    await Promise.resolve();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledWith(ownerAccess);
    expect(listener.mock.calls.every(([access]) => access.authenticated)).toBe(true);
    stop();
  });
  it('ignores a status request started during sign-in but completed after its success', async () => {
    let finishLogin!: (value: RankingsReply) => void;
    let finishStatus!: (value: RankingsAccess) => void;
    owner.loginRankings.mockReturnValueOnce(
      new Promise((done) => {
        finishLogin = done;
      }),
    );
    owner.loadRankingsAccess.mockReturnValueOnce(
      new Promise((done) => {
        finishStatus = done;
      }),
    );
    const login = client.loginRankings('keeper', 'password');
    const status = client.readAccess();
    finishLogin(reply());
    await login;
    finishStatus(visitor);
    expect(await status).toEqual(ownerAccess);
  });
  it('ignores status started during logout and completed after the cookie has been cleared', async () => {
    let finishLogout!: (value: RankingsReply) => void;
    let finishStatus!: (value: RankingsAccess) => void;
    owner.logoutRankings.mockReturnValueOnce(
      new Promise((done) => {
        finishLogout = done;
      }),
    );
    owner.loadRankingsAccess.mockReturnValueOnce(
      new Promise((done) => {
        finishStatus = done;
      }),
    );
    const logout = client.logoutRankings();
    const status = client.readAccess();
    finishLogout(reply(visitor));
    await logout;
    finishStatus(ownerAccess);
    expect(await status).toEqual(visitor);
  });
  it('ignores a late authenticated status after logout and after unsubscribe', async () => {
    let finish!: (value: RankingsAccess) => void;
    owner.loadRankingsAccess.mockReturnValueOnce(
      new Promise((done) => {
        finish = done;
      }),
    );
    const listener = vi.fn();
    const stop = client.watchRankingsAccess(listener);
    await client.logoutRankings();
    finish(ownerAccess);
    await Promise.resolve();
    await Promise.resolve();
    expect(listener.mock.calls.every(([access]) => !access.authenticated)).toBe(true);
    stop();
    const count = listener.mock.calls.length;
    await client.loginRankings('keeper', 'password');
    expect(listener).toHaveBeenCalledTimes(count);
  });
});
