import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyRankings } from './model';
import { loadRankingsAccess, loginRankings, logoutRankings, saveRankings } from './http-client';
const fetchMock = vi.fn();
const access = { authenticated: true, configured: true, canSetup: false };
const reply = { data: emptyRankings(), access };
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(reply), { status: 200 }));
});
afterEach(() => vi.unstubAllGlobals());
describe('same-origin rankings owner API', () => {
  it('reads access-only status using the HttpOnly browser cookie without needing ledger data', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ access }), { status: 200 }));
    expect(await loadRankingsAccess()).toEqual(access);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/rankings/access',
      expect.objectContaining({
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        body: undefined,
      }),
    );
  });
  it('sends username/password as a POST body, never a URL parameter', async () => {
    expect(await loginRankings('keeper', 'owner-secret')).toEqual(reply);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/rankings/login',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        body: JSON.stringify({ username: 'keeper', password: 'owner-secret' }),
      }),
    );
  });
  it('uses the server save and logout routes', async () => {
    await saveRankings(emptyRankings());
    await logoutRankings();
    expect(fetchMock.mock.calls.map(([url, options]) => [url, options.method])).toEqual([
      ['/api/rankings', 'PUT'],
      ['/api/rankings/logout', 'POST'],
    ]);
  });
  it.each([null, {}, { access: { authenticated: 'true', configured: true, canSetup: false } }])(
    'rejects malformed access payloads (%#)',
    async (payload) => {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }));
      await expect(loadRankingsAccess()).rejects.toMatchObject({ status: 502 });
    },
  );
  it('preserves explicit authentication failures', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Invalid username or password.' }), { status: 401 }),
    );
    await expect(loginRankings('keeper', 'bad')).rejects.toMatchObject({
      status: 401,
      message: 'Invalid username or password.',
    });
  });
  it('rejects invalid saved ledger responses', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access, data: { version: 2 } }), { status: 200 }),
    );
    await expect(saveRankings(emptyRankings())).rejects.toMatchObject({ status: 502 });
  });
});
