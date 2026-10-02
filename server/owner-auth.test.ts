import { describe, expect, it } from 'vitest';
import {
  MemoryOwnerAuthStore,
  matchesOwner,
  ownerCredentials,
  OWNER_LOGIN_WINDOW,
} from './owner-auth';

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
