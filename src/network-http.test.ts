import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpCatanConnection } from './network-http';
import type { RoomSnapshot, Session } from './network';

const session: Session = { code: 'ABC234', token: 'a'.repeat(64), player: 0 };
const snapshot = (revision = 1): RoomSnapshot => ({
  code: session.code,
  revision,
  mode: 'standard',
  capacity: 3,
  host: 0,
  players: [{ id: 0, name: 'Ada', connected: true }],
  game: null,
  you: 0,
  resourceCounts: {},
  devCounts: {},
  pendingTrade: null,
});
const response = (value: unknown, status = 200) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => value });
const success = (revision = 1) => response({ ok: true, state: snapshot(revision), session });
let fetchMock: ReturnType<typeof vi.fn>;
let doc: EventTarget & { hidden: boolean };
let connection: HttpCatanConnection;
let values: Map<string, string>;
beforeEach(() => {
  vi.useFakeTimers();
  doc = Object.assign(new EventTarget(), { hidden: false });
  values = new Map();
  vi.stubGlobal('document', doc);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  fetchMock = vi.fn().mockImplementation(() => success());
  vi.stubGlobal('fetch', fetchMock);
  connection = new HttpCatanConnection();
});
afterEach(() => {
  connection.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('HTTP room connection', () => {
  it('stays idle until joining and authenticates polls without exposing bearer tokens in URLs', async () => {
    const states = vi.fn();
    connection.onState(states);
    expect(fetchMock).not.toHaveBeenCalled();
    await connection.create({ name: 'Ada', mode: 'standard', capacity: 3 });
    expect(states).toHaveBeenCalledTimes(1);
    expect(connection.savedSession()).toEqual(session);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe('/api/online/rooms/ABC234');
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe(`Bearer ${session.token}`);
    expect(fetchMock.mock.calls[1][0]).not.toContain(session.token);
    expect(states).toHaveBeenCalledTimes(1); // Identical snapshots do not redraw the 3D scene.
  });
  it('publishes an unchanged snapshot after a transient failure so game controls reconnect', async () => {
    const states = vi.fn();
    const disconnected = vi.fn();
    connection.onState(states);
    connection.onDisconnect(disconnected);
    await connection.create({ name: 'Ada', mode: 'standard', capacity: 3 });
    fetchMock.mockRejectedValueOnce(new TypeError('Network unavailable'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(disconnected).toHaveBeenCalledTimes(1);
    expect(states).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(states).toHaveBeenCalledTimes(2);
    expect(states.mock.lastCall?.[0]).toEqual(snapshot());
    await vi.advanceTimersByTimeAsync(2000);
    expect(states).toHaveBeenCalledTimes(2);
  });
  it('keeps one poll in flight and slows polling in hidden tabs', async () => {
    await connection.create({ name: 'Ada', mode: 'standard', capacity: 3 });
    let resolve!: (value: unknown) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    await vi.advanceTimersByTimeAsync(2000);
    doc.dispatchEvent(new Event('visibilitychange'));
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    doc.hidden = true;
    resolve(await success(2));
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(14_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it('stops after another tab takes the seat and requires an explicit resume', async () => {
    const disconnected = vi.fn();
    connection.onDisconnect(disconnected);
    await connection.create({ name: 'Ada', mode: 'standard', capacity: 3 });
    fetchMock.mockImplementationOnce(() =>
      response({ ok: false, error: 'Another tab owns this seat.' }, 409),
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(disconnected).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(connection.start()).rejects.toThrow('Resume your saved game session');
    expect(connection.savedSession()).toEqual(session);
    await connection.resume(session);
    expect(fetchMock.mock.calls[2][0]).toBe('/api/online/resume');
    expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe(`Bearer ${session.token}`);
  });
  it('sends the authoritative revision and refreshes after a conflict without replaying the move', async () => {
    const states = vi.fn();
    connection.onState(states);
    await connection.create({ name: 'Ada', mode: 'standard', capacity: 3 });
    fetchMock.mockImplementationOnce(() =>
      response({ ok: false, error: 'The room changed.' }, 412),
    );
    fetchMock.mockImplementationOnce(() => success(2));
    await expect(connection.start()).rejects.toThrow('The room changed.');
    await vi.advanceTimersByTimeAsync(1);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).revision).toBe(1);
    expect(fetchMock.mock.calls[2][1].method).toBe('GET');
    expect(states.mock.lastCall?.[0].revision).toBe(2);
    expect(fetchMock.mock.calls.filter((call) => call[0].endsWith('/start'))).toHaveLength(1);
  });
  it('releases presence and aborts requests when closed', async () => {
    await connection.create({ name: 'Ada', mode: 'standard', capacity: 3 });
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementationOnce((_url, options) => {
      signal = options.signal;
      return new Promise(() => {});
    });
    await vi.advanceTimersByTimeAsync(2000);
    connection.close();
    expect(signal?.aborted).toBe(true);
    expect(fetchMock.mock.lastCall?.[0]).toBe('/api/online/rooms/ABC234/disconnect');
    expect(fetchMock.mock.lastCall?.[1].keepalive).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
