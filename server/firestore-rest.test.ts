import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { createFirestoreRest, FirestoreRestError } from './firestore-rest.js';

const resource = 'projects/demo-catan-rest/databases/(default)/documents';
const origin = `http://127.0.0.1:8181/v1/${resource}`;
const secret = 'test-id-token-not-for-logs';
let fetchMock: ReturnType<typeof vi.fn>;
const ok = (value: unknown = {}) =>
  Promise.resolve(new Response(JSON.stringify(value), { status: 200 }));
const failure = (status: number, code: string) =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        error: { status: code, message: `secret ${secret} and internal database location` },
      }),
      { status },
    ),
  );
const config = () => ({
  projectId: 'demo-catan-rest',
  emulatorHost: '127.0.0.1:8181',
  getToken: async () => secret,
});
const doc = (path: string, fields: Record<string, unknown> = {}) => ({
  name: `${resource}/${path}`,
  fields,
});
const payload = (call: number) => JSON.parse(fetchMock.mock.calls[call][1].body);
beforeEach(() => {
  fetchMock = vi.fn().mockImplementation(() => ok());
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('NODE_ENV', 'test');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
describe('ID-token Firestore REST facade', () => {
  it('uses bearer headers and encodes document path segments without query injection', async () => {
    const db = createFirestoreRest(config());
    const path = 'catan/path?mask=x#fragment';
    fetchMock.mockImplementationOnce(() => ok(doc(path, { enabled: { booleanValue: true } })));
    const snapshot = await db.doc(path).get();
    expect(fetchMock.mock.calls[0][0]).toBe(`${origin}/catan/path%3Fmask%3Dx%23fragment`);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${secret}`);
    expect(fetchMock.mock.calls[0][1].redirect).toBe('error');
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(snapshot.exists).toBe(true);
    expect(snapshot.id).toBe('path?mask=x#fragment');
    expect(snapshot.data()).toEqual({ enabled: true });
    expect(snapshot.get('enabled')).toBe(true);
  });
  it.each([
    'https://attacker.example',
    'attacker.example:8181',
    'localhost:8181@attacker.example',
    '127.0.0.1:0',
    '127.0.0.1:65536',
  ])('rejects untrusted emulator endpoint %s', (emulatorHost) => {
    expect(() => createFirestoreRest({ ...config(), emulatorHost })).toThrow(FirestoreRestError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('permits only demo emulator projects outside production', () => {
    expect(() => createFirestoreRest({ ...config(), projectId: 'real-project' })).toThrow(
      FirestoreRestError,
    );
    expect(() => createFirestoreRest({ ...config(), emulatorHost: undefined })).toThrow(
      FirestoreRestError,
    );
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => createFirestoreRest(config())).toThrow(FirestoreRestError);
  });
  it.each([
    '',
    '/catan/rankings',
    'catan',
    'catan/../other/document',
    'catan//record/x',
    'catan/__reserved__',
    'catan/record\n',
  ])('rejects malformed document path %s', (path) => {
    expect(() => createFirestoreRest(config()).doc(path)).toThrow(FirestoreRestError);
  });
  it('fixes the production destination to the Google Firestore host', async () => {
    const db = createFirestoreRest({
      projectId: 'catan-production',
      databaseId: 'rankings-db',
      getToken: async () => secret,
    });
    await db.doc('catan/rankings').delete();
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://firestore.googleapis.com/v1/projects/catan-production/databases/rankings-db/documents:commit',
    );
  });
  it('round trips primitives, nested maps/arrays, bytes, and nanosecond Admin timestamps', async () => {
    const db = createFirestoreRest(config());
    const data = {
      name: 'Ada',
      total: 12,
      ratio: 1.25,
      active: true,
      empty: null,
      values: [1, false, { label: 'city' }],
      config: { enabled: false, list: [] },
      time: new Timestamp(1_700_000_000, 123456789),
      negative: new Timestamp(-1, 999999999),
      bytes: Buffer.from([0, 1, 255]),
    };
    await db.doc('catan/rankings').set(data);
    const fields = payload(0).writes[0].update.fields;
    expect(fields.total).toEqual({ integerValue: '12' });
    expect(fields.ratio).toEqual({ doubleValue: 1.25 });
    expect(fields.time.timestampValue).toBe('2023-11-14T22:13:20.123456789Z');
    fetchMock.mockImplementationOnce(() => ok(doc('catan/rankings', fields)));
    const snapshot = await db.doc('catan/rankings').get();
    expect(snapshot.data()).toEqual(data);
    expect(snapshot.get('time')).toBeInstanceOf(Timestamp);
    const mutated = snapshot.data()!;
    mutated.config = null;
    expect(snapshot.data()).toEqual(data);
  });
  it('represents missing documents without suppressing permission failures', async () => {
    const db = createFirestoreRest(config());
    fetchMock.mockImplementationOnce(() => failure(404, 'NOT_FOUND'));
    const missing = await db.doc('catan/absent').get();
    expect(missing.exists).toBe(false);
    expect(missing.data()).toBeUndefined();
    fetchMock.mockImplementationOnce(() => failure(403, 'PERMISSION_DENIED'));
    await expect(db.doc('catan/absent').get()).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      status: 403,
    });
  });
  it('binds document and parallel query reads to the same transaction and commits once', async () => {
    const db = createFirestoreRest(config());
    fetchMock
      .mockImplementationOnce(() => ok({ transaction: 'transaction-one' }))
      .mockImplementationOnce(() =>
        ok([{ found: doc('catan/rankings', { revision: { integerValue: '1' } }) }]),
      )
      .mockImplementationOnce(() =>
        ok([{ document: doc('catan/rankings/players/ada', { id: { stringValue: 'ada' } }) }]),
      )
      .mockImplementationOnce(() => ok([{ readTime: '2026-10-02T00:00:00Z' }]))
      .mockImplementationOnce(() => ok({ commitTime: '2026-10-02T00:00:00Z' }));
    const result = await db.runTransaction(async (tx) => {
      const root = db.doc('catan/rankings');
      expect((await tx.get(root)).get('revision')).toBe(1);
      const [players, games] = await Promise.all([
        tx.get(root.collection('players').limit(501)),
        tx.get(root.collection('games').limit(2001)),
      ]);
      expect(players.docs[0].id).toBe('ada');
      expect(players.size).toBe(1);
      expect(games.empty).toBe(true);
      tx.set(root, { revision: 2 });
      tx.create(root.collection('games').doc('first'), { title: 'First game' });
      tx.delete(root.collection('players').doc('old'));
      return 42;
    });
    expect(result).toBe(42);
    expect(payload(0)).toEqual({ options: { readWrite: {} } });
    expect(payload(1)).toEqual({
      documents: [`${resource}/catan/rankings`],
      transaction: 'transaction-one',
    });
    expect(payload(2)).toEqual({
      structuredQuery: { from: [{ collectionId: 'players' }], limit: 501 },
      transaction: 'transaction-one',
    });
    expect(fetchMock.mock.calls[2][0]).toBe(`${origin}/catan/rankings:runQuery`);
    expect(payload(3).transaction).toBe('transaction-one');
    expect(payload(4).transaction).toBe('transaction-one');
    expect(payload(4).writes[1].currentDocument).toEqual({ exists: false });
    expect(payload(4).writes[2]).toEqual({ delete: `${resource}/catan/rankings/players/old` });
  });
  it('supports consistent read-only transactions and missing transactional documents', async () => {
    const db = createFirestoreRest(config());
    fetchMock
      .mockImplementationOnce(() => ok({ transaction: 'read-only' }))
      .mockImplementationOnce(() => ok([{ missing: `${resource}/catan/missing` }]))
      .mockImplementationOnce(() => ok());
    await db.runTransaction(
      async (tx) => {
        expect((await tx.get(db.doc('catan/missing'))).exists).toBe(false);
      },
      { readOnly: true },
    );
    expect(payload(0)).toEqual({ options: { readOnly: {} } });
    expect(payload(2)).toEqual({ writes: [], transaction: 'read-only' });
  });
  it('retries only a known ABORTED conflict with a new transaction', async () => {
    vi.useFakeTimers();
    const db = createFirestoreRest(config());
    const callback = vi.fn((tx) => {
      tx.set(db.doc('catan/rankings'), { value: callback.mock.calls.length });
      return Promise.resolve('saved');
    });
    fetchMock
      .mockImplementationOnce(() => ok({ transaction: 'first' }))
      .mockImplementationOnce(() => failure(409, 'ABORTED'))
      .mockImplementationOnce(() => ok()) // rollback
      .mockImplementationOnce(() => ok({ transaction: 'second' }))
      .mockImplementationOnce(() => ok());
    const pending = db.runTransaction(callback);
    await vi.runAllTimersAsync();
    expect(await pending).toBe('saved');
    expect(callback).toHaveBeenCalledTimes(2);
    expect(payload(1).transaction).toBe('first');
    expect(payload(2).transaction).toBe('first');
    expect(payload(4).transaction).toBe('second');
  });
  it.each(['UNAVAILABLE', 'INTERNAL', 'UNKNOWN', 'PERMISSION_DENIED'])(
    'does not replay a commit with %s',
    async (code) => {
      const db = createFirestoreRest(config());
      fetchMock
        .mockImplementationOnce(() => ok({ transaction: 'uncertain' }))
        .mockImplementationOnce(() => failure(503, code))
        .mockImplementationOnce(() => ok());
      const callback = vi.fn(async (tx) => {
        tx.set(db.doc('catan/rankings'), { revision: 2 });
      });
      await expect(db.runTransaction(callback)).rejects.toMatchObject({ code });
      expect(callback).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls.filter((call) => call[0].endsWith(':commit'))).toHaveLength(1);
    },
  );
  it('never repeats a commit after a lost network response and strips provider secrets', async () => {
    const db = createFirestoreRest(config());
    fetchMock
      .mockImplementationOnce(() => ok({ transaction: 'uncertain' }))
      .mockRejectedValueOnce(new Error(`socket error containing ${secret}`))
      .mockImplementationOnce(() => ok());
    let error: unknown;
    try {
      await db.runTransaction(async (tx) => {
        tx.set(db.doc('catan/rankings'), { revision: 2 });
      });
    } catch (value) {
      error = value;
    }
    expect(error).toBeInstanceOf(FirestoreRestError);
    expect(String(error)).not.toContain(secret);
    expect(fetchMock.mock.calls.filter((call) => call[0].endsWith(':commit'))).toHaveLength(1);
  });
  it('rolls back application errors without re-running the callback or changing the error', async () => {
    const db = createFirestoreRest(config());
    const conflict = new Error('Owner chose an outdated revision.');
    fetchMock
      .mockImplementationOnce(() => ok({ transaction: 'application-error' }))
      .mockImplementationOnce(() => ok());
    await expect(
      db.runTransaction(async () => {
        throw conflict;
      }),
    ).rejects.toBe(conflict);
    expect(fetchMock.mock.calls[1][0]).toBe(`${origin}:rollback`);
    expect(fetchMock.mock.calls).toHaveLength(2);
  });
  it('rejects reads after writes, writes during unfinished reads, and read-only writes', async () => {
    for (const mode of ['after-write', 'pending-read', 'read-only']) {
      const db = createFirestoreRest(config());
      fetchMock.mockImplementation(() => ok({ transaction: 'ordering' }));
      if (mode === 'pending-read')
        fetchMock
          .mockImplementationOnce(() => ok({ transaction: 'ordering' }))
          .mockImplementationOnce(() => ok([{ missing: `${resource}/catan/rankings` }]));
      await expect(
        db.runTransaction(
          async (tx) => {
            const ref = db.doc('catan/rankings');
            if (mode === 'after-write') {
              tx.set(ref, {});
              await tx.get(ref);
            } else if (mode === 'pending-read') {
              const pending = tx.get(ref);
              try {
                tx.set(ref, {});
              } finally {
                await pending;
              }
            } else tx.set(ref, {});
          },
          mode === 'read-only' ? { readOnly: true } : {},
        ),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
  });
  it('rejects references from another adapter and invalid value shapes', async () => {
    const first = createFirestoreRest(config()),
      second = createFirestoreRest(config());
    expect(() => first.batch().delete(second.doc('catan/rankings'))).toThrow(FirestoreRestError);
    expect(() => first.batch().set(first.doc('catan/rankings'), { value: undefined })).toThrow(
      FirestoreRestError,
    );
    expect(() => first.batch().set(first.doc('catan/rankings'), { value: [[1]] })).toThrow(
      FirestoreRestError,
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => first.batch().set(first.doc('catan/rankings'), cyclic)).toThrow(
      FirestoreRestError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('never sends tokens after termination or a failed token provider', async () => {
    const db = createFirestoreRest(config());
    await db.terminate();
    await expect(db.doc('catan/rankings').get()).rejects.toMatchObject({
      code: 'FAILED_PRECONDITION',
    });
    const broken = createFirestoreRest({
      ...config(),
      getToken: async () => {
        throw Error(secret);
      },
    });
    await expect(broken.doc('catan/rankings').get()).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
