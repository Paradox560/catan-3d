import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryOwnerAuthStore,
  matchesOwner,
  ownerCredentials,
  ownerConfigurationIssue,
  OWNER_LOGIN_WINDOW,
} from './owner-auth';

const storage = vi.hoisted(() => ({
  create: vi.fn(async () => ({ store: {}, ownerAuth: {} })),
}));
vi.mock('./rankings-storage.js', () => ({ createRankingsServices: storage.create }));
import { rankingsRouter } from './rankings';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const environment = {
  RANKINGS_ADMIN_USERNAME: 'test-keeper',
  RANKINGS_ADMIN_PASSWORD: 'private-test-password',
};

describe('environment owner identity', () => {
  it.each([
    {},
    { RANKINGS_ADMIN_USERNAME: 'owner' },
    { RANKINGS_ADMIN_PASSWORD: 'a-long-password' },
    { ...environment, RANKINGS_ADMIN_USERNAME: '' },
    { ...environment, RANKINGS_ADMIN_USERNAME: ' owner' },
    { ...environment, RANKINGS_ADMIN_USERNAME: 'o\u0000wner' },
    { ...environment, RANKINGS_ADMIN_USERNAME: 'a'.repeat(129) },
    { ...environment, RANKINGS_ADMIN_PASSWORD: '' },
    { ...environment, RANKINGS_ADMIN_PASSWORD: 'short' },
    { ...environment, RANKINGS_ADMIN_PASSWORD: 'é'.repeat(513) },
  ])('disables editing for missing or invalid environment credentials (%#)', (env) => {
    expect(ownerCredentials(env)).toBeNull();
  });
  it('uses stable credential identity across independent instances and invalidates either rotated value', () => {
    const original = ownerCredentials(environment)!;
    expect(ownerCredentials(environment)!.fingerprint).toBe(original.fingerprint);
    expect(
      ownerCredentials({ ...environment, RANKINGS_ADMIN_USERNAME: 'next-keeper' })!.fingerprint,
    ).not.toBe(original.fingerprint);
    expect(
      ownerCredentials({ ...environment, RANKINGS_ADMIN_PASSWORD: 'another-test-password' })!
        .fingerprint,
    ).not.toBe(original.fingerprint);
    expect(JSON.stringify(original)).not.toContain(environment.RANKINGS_ADMIN_PASSWORD);
  });
  it('requires both exact username and password, with the same failure for missing or incorrect inputs', async () => {
    const credentials = ownerCredentials(environment)!;
    expect(
      await matchesOwner(
        environment.RANKINGS_ADMIN_USERNAME,
        environment.RANKINGS_ADMIN_PASSWORD,
        credentials,
      ),
    ).toBe(true);
    for (const [username, password] of [
      ['wrong-name', environment.RANKINGS_ADMIN_PASSWORD],
      [environment.RANKINGS_ADMIN_USERNAME, 'wrong-password'],
      [undefined, environment.RANKINGS_ADMIN_PASSWORD],
      [environment.RANKINGS_ADMIN_USERNAME, undefined],
      [environment.RANKINGS_ADMIN_USERNAME, 'x'.repeat(1025)],
      [
        { toString: () => environment.RANKINGS_ADMIN_USERNAME },
        environment.RANKINGS_ADMIN_PASSWORD,
      ],
    ])
      expect(await matchesOwner(username, password, credentials)).toBe(false);
  });
});

describe('safe owner configuration diagnostics', () => {
  it.each([
    [{ ...environment, RANKINGS_ADMIN_USERNAME: undefined }, 'username-missing'],
    [{ ...environment, RANKINGS_ADMIN_USERNAME: '' }, 'username-missing'],
    [
      { ...environment, RANKINGS_ADMIN_USERNAME: ' private-owner' },
      'username-surrounding-whitespace',
    ],
    [
      { ...environment, RANKINGS_ADMIN_USERNAME: 'private-owner\n' },
      'username-surrounding-whitespace',
    ],
    [{ ...environment, RANKINGS_ADMIN_USERNAME: 'u'.repeat(129) }, 'username-too-long'],
    [
      { ...environment, RANKINGS_ADMIN_USERNAME: 'private\u0000owner' },
      'username-invalid-characters',
    ],
    [
      { ...environment, RANKINGS_ADMIN_USERNAME: 'private\u007fowner' },
      'username-invalid-characters',
    ],
    [{ ...environment, RANKINGS_ADMIN_PASSWORD: undefined }, 'password-missing'],
    [{ ...environment, RANKINGS_ADMIN_PASSWORD: '' }, 'password-missing'],
    [{ ...environment, RANKINGS_ADMIN_PASSWORD: 'p'.repeat(9) }, 'password-too-short'],
    [{ ...environment, RANKINGS_ADMIN_PASSWORD: 'p'.repeat(1025) }, 'password-too-long'],
    [{ ...environment, RANKINGS_ADMIN_PASSWORD: 'é'.repeat(513) }, 'password-too-long'],
  ] as const)(
    'returns only a fixed reason and disables invalid credentials (%#)',
    (env, reason) => {
      expect(ownerConfigurationIssue(env)).toBe(reason);
      expect(ownerCredentials(env)).toBeNull();
    },
  );
  it.each([
    { ...environment, RANKINGS_ADMIN_USERNAME: 'u'.repeat(128) },
    { ...environment, RANKINGS_ADMIN_PASSWORD: 'p'.repeat(10) },
    { ...environment, RANKINGS_ADMIN_PASSWORD: 'p'.repeat(1024) },
    { ...environment, RANKINGS_ADMIN_PASSWORD: 'é'.repeat(512) },
    { ...environment, RANKINGS_ADMIN_PASSWORD: ' preserved-password-whitespace ' },
  ])('preserves valid boundaries and existing password whitespace behavior (%#)', (env) => {
    expect(ownerConfigurationIssue(env)).toBeNull();
    expect(ownerCredentials(env)).not.toBeNull();
  });
  it('reports the first validation failure without inspecting or returning secret content', () => {
    expect(ownerConfigurationIssue({ RANKINGS_ADMIN_PASSWORD: 'private-value' })).toBe(
      'username-missing',
    );
    expect(
      ownerConfigurationIssue({
        RANKINGS_ADMIN_USERNAME: 'bad owner\n',
        RANKINGS_ADMIN_PASSWORD: 'short',
      }),
    ).toBe('username-surrounding-whitespace');
  });
  it('logs only one fixed diagnostic at router initialization without values, lengths, or hashes', async () => {
    vi.stubEnv('RANKINGS_ADMIN_USERNAME', 'sensitive-owner-name');
    vi.stubEnv('RANKINGS_ADMIN_PASSWORD', 's3cr3t!');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const router = rankingsRouter('/unused-owner-diagnostic-test');
    expect(router).toBeDefined();
    await Promise.resolve();
    expect(logged.mock.calls).toEqual([['Rankings owner access disabled:', 'password-too-short']]);
    expect(JSON.stringify(logged.mock.calls)).not.toContain('sensitive-owner-name');
    expect(JSON.stringify(logged.mock.calls)).not.toContain('s3cr3t!');
    ownerConfigurationIssue();
    ownerCredentials();
    expect(logged).toHaveBeenCalledTimes(1);
  });
  it('does not log credentials or any diagnostic for a configured owner', async () => {
    vi.stubEnv('RANKINGS_ADMIN_USERNAME', environment.RANKINGS_ADMIN_USERNAME);
    vi.stubEnv('RANKINGS_ADMIN_PASSWORD', environment.RANKINGS_ADMIN_PASSWORD);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    rankingsRouter('/unused-owner-diagnostic-test');
    await Promise.resolve();
    expect(logged).not.toHaveBeenCalled();
  });
});

describe('local owner sessions and rate limits', () => {
  it('expires and revokes sessions and replaces the previous cookie', async () => {
    const store = new MemoryOwnerAuthStore();
    const session = { fingerprint: 'test', expires: Date.now() + 10_000 };
    await store.issueSession('first', session, null);
    expect(await store.readSession('first')).toEqual(session);
    await store.issueSession('second', session, 'first');
    expect(await store.readSession('first')).toBeNull();
    await store.revokeSession('second');
    expect(await store.readSession('second')).toBeNull();
    await store.issueSession('expired', { ...session, expires: Date.now() - 1 }, null);
    expect(await store.readSession('expired')).toBeNull();
  });
  it('reserves only ten attempts and resumes after expiry or a successful login', async () => {
    const store = new MemoryOwnerAuthStore();
    for (let i = 0; i < 10; i++)
      expect((await store.reserveLogin('owner', 1_000)).allowed).toBe(true);
    expect((await store.reserveLogin('owner', 1_001)).allowed).toBe(false);
    expect((await store.reserveLogin('owner', 1_000 + OWNER_LOGIN_WINDOW)).allowed).toBe(true);
    await store.clearLogins('owner');
    expect((await store.reserveLogin('owner', 1_002)).allowed).toBe(true);
  });
});
