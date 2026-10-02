import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  fromJSON: vi.fn(),
  getAccessToken: vi.fn(),
  getVercelOidcToken: vi.fn(),
  setCredentials: vi.fn(),
}));
vi.mock('@vercel/oidc', () => ({ getVercelOidcToken: sdk.getVercelOidcToken }));
vi.mock('google-auth-library', () => ({ ExternalAccountClient: { fromJSON: sdk.fromJSON } }));

import { createWebAuth, parseWebAuthConfig } from './firebase-web-auth.js';

const configured: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  VERCEL: '1',
  FIREBASE_API_KEY: 'fixture-api-key-never-a-real-key',
  FIREBASE_AUTH_DOMAIN: 'fixture-catan.firebaseapp.com',
  FIREBASE_PROJECT_ID: 'fixture-catan',
  FIREBASE_APP_ID: '1:123456789:web:012345abcdef',
};
const emulator = {
  ...configured,
  VERCEL: undefined,
  FIREBASE_PROJECT_ID: 'demo-catan-rankings',
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8181',
};
const provider =
  'iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/catan-vercel/providers/vercel';
const failure =
  'Firebase keyless authentication failed. Check Vercel OIDC and the Google Cloud workload identity setup.';
const closed = 'Firebase backend authentication has been closed.';
const bearer = 'fixture-access-token-never-a-real-token';

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('VERCEL', undefined);
  vi.stubEnv('FIREBASE_AUTH_EMULATOR_HOST', undefined);
  vi.stubEnv('FIRESTORE_EMULATOR_HOST', undefined);
  sdk.fromJSON.mockImplementation((options) => ({
    getAccessToken: () => sdk.getAccessToken(options),
    setCredentials: sdk.setCredentials,
  }));
  sdk.getAccessToken.mockImplementation(async (options) => {
    await options.subject_token_supplier.getSubjectToken();
    return { token: bearer };
  });
  sdk.getVercelOidcToken.mockResolvedValue('fixture.subject.token');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('Firebase Console web configuration', () => {
  it('parses standard web values without backend account variables or network activity', () => {
    const parsed = parseWebAuthConfig(configured);
    expect(parsed.options).toEqual({
      apiKey: configured.FIREBASE_API_KEY,
      authDomain: configured.FIREBASE_AUTH_DOMAIN,
      projectId: configured.FIREBASE_PROJECT_ID,
      appId: configured.FIREBASE_APP_ID,
    });
    expect(parsed.projectNumber).toBe('123456789');
    expect(parsed.workload).toEqual({
      audience: `//${provider}`,
      oidcAudience: `https://${provider}`,
      serviceAccount: 'catan-api@fixture-catan.iam.gserviceaccount.com',
    });
    expect(parsed).not.toHaveProperty('backend');
    expect(sdk.fromJSON).not.toHaveBeenCalled();
    expect(sdk.getVercelOidcToken).not.toHaveBeenCalled();
  });
  it('accepts the exact Console JSON keys with optional fields', () => {
    const options = {
      apiKey: configured.FIREBASE_API_KEY,
      authDomain: configured.FIREBASE_AUTH_DOMAIN,
      projectId: configured.FIREBASE_PROJECT_ID,
      appId: configured.FIREBASE_APP_ID,
      storageBucket: 'fixture-catan.firebasestorage.app',
      messagingSenderId: '123456789',
      measurementId: 'G-TEST123',
      databaseURL: 'https://fixture-catan.firebaseio.com',
    };
    expect(parseWebAuthConfig({ FIREBASE_CONFIG: JSON.stringify(options) }).options).toEqual(
      options,
    );
  });
  it('does not let arbitrary JSON fields override trusted identity URLs', () => {
    const options = parseWebAuthConfig(configured).options;
    const parsed = parseWebAuthConfig({
      FIREBASE_CONFIG: JSON.stringify({
        ...options,
        token_url: 'https://attacker.invalid',
        audience: '//attacker.invalid',
        credential_source: { file: '/private/file' },
      }),
    });
    expect(parsed.options).toEqual(options);
    expect(parsed.workload.audience).toBe(`//${provider}`);
  });
  it('ignores retired backend account variables', () => {
    expect(
      parseWebAuthConfig({
        ...configured,
        FIREBASE_BACKEND_EMAIL: '',
        FIREBASE_BACKEND_PASSWORD: '',
        FIREBASE_BACKEND_UID: '',
      }),
    ).toEqual(parseWebAuthConfig(configured));
  });
  it.each([
    'FIREBASE_API_KEY',
    'FIREBASE_AUTH_DOMAIN',
    'FIREBASE_PROJECT_ID',
    'FIREBASE_APP_ID',
    'FIREBASE_STORAGE_BUCKET',
  ])('rejects mixed JSON and individual fields, including empty %s', (key) => {
    expect(() => parseWebAuthConfig({ ...configured, FIREBASE_CONFIG: '{}', [key]: '' })).toThrow(
      /not both/,
    );
  });
  it.each(['{bad-json-private-value', 'null', '[]', '"private-value"'])(
    'sanitizes invalid FIREBASE_CONFIG (%#)',
    (json) => {
      expect(() => parseWebAuthConfig({ FIREBASE_CONFIG: json })).toThrow(
        'FIREBASE_CONFIG must contain the Firebase Console web configuration as a JSON object.',
      );
    },
  );
  it.each([
    ['FIREBASE_API_KEY', undefined],
    ['FIREBASE_API_KEY', ''],
    ['FIREBASE_API_KEY', 'bad key'],
    ['FIREBASE_PROJECT_ID', 'invalid/project'],
    ['FIREBASE_PROJECT_ID', ''],
    ['FIREBASE_AUTH_DOMAIN', 'https://fixture-catan.firebaseapp.com'],
    ['FIREBASE_AUTH_DOMAIN', undefined],
    ['FIREBASE_APP_ID', undefined],
    ['FIREBASE_APP_ID', '1:123:android:abcdef'],
    ['FIREBASE_APP_ID', '1:../../etc:web:abcdef'],
    ['FIREBASE_APP_ID', '1:000123:web:abcdef'],
    ['FIREBASE_APP_ID', '1:123456789012345678901:web:abcdef'],
    ['FIREBASE_MESSAGING_SENDER_ID', 'not-numeric'],
    ['FIREBASE_MESSAGING_SENDER_ID', '987654321'],
    ['FIREBASE_DATABASE_URL', 'http://untrusted.invalid'],
    ['FIREBASE_DATABASE_URL', 'https://user:password@untrusted.invalid'],
  ])('rejects invalid or missing %s (%#)', (key, value) => {
    expect(() => parseWebAuthConfig({ ...configured, [key as string]: value })).toThrow(
      key as string,
    );
  });
  it('preserves project numbers as strings without numeric rounding', () => {
    const parsed = parseWebAuthConfig({
      ...configured,
      FIREBASE_APP_ID: '1:12345678901234567890:web:abcdef',
      FIREBASE_MESSAGING_SENDER_ID: '12345678901234567890',
    });
    expect(parsed.projectNumber).toBe('12345678901234567890');
    expect(parsed.workload.audience).toContain('/12345678901234567890/');
  });
});

describe('isolated Firestore emulator', () => {
  it('accepts a loopback Firestore endpoint alone for a nonproduction demo project', async () => {
    expect(parseWebAuthConfig(emulator).firestoreEmulatorHost).toBe('127.0.0.1:8181');
    expect(
      parseWebAuthConfig({ ...emulator, FIRESTORE_EMULATOR_HOST: '[::1]:8181' })
        .firestoreEmulatorHost,
    ).toBe('[::1]:8181');
    const connection = createWebAuth(emulator);
    expect(await connection.getToken()).toBe('owner');
    expect(sdk.fromJSON).not.toHaveBeenCalled();
    expect(sdk.getVercelOidcToken).not.toHaveBeenCalled();
    await connection.close();
    await expect(connection.getToken()).rejects.toThrow(closed);
  });
  it('allows an unrelated loopback Auth emulator alongside isolated Firestore', () => {
    expect(() =>
      parseWebAuthConfig({ ...emulator, FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' }),
    ).not.toThrow();
  });
  it.each([
    { FIRESTORE_EMULATOR_HOST: undefined },
    { FIREBASE_PROJECT_ID: 'fixture-real-project' },
    { NODE_ENV: 'production' },
    { VERCEL: '1' },
    { FIRESTORE_EMULATOR_HOST: 'https://localhost:8181' },
    { FIRESTORE_EMULATOR_HOST: 'remote.invalid:8181' },
    { FIRESTORE_EMULATOR_HOST: '127.0.0.1:0' },
    { FIRESTORE_EMULATOR_HOST: '127.0.0.1:65536' },
  ])('rejects cloud/emulator mixing or unsafe endpoints (%#)', (values) => {
    expect(() => parseWebAuthConfig({ ...emulator, ...values })).toThrow();
  });
  it('rejects an isolated Auth emulator for a cloud project', () => {
    expect(() =>
      parseWebAuthConfig({ ...configured, FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' }),
    ).toThrow(/cloud Firestore/);
  });
  it('validates inherited process emulator configuration and rejects mismatches', () => {
    vi.stubEnv('FIRESTORE_EMULATOR_HOST', 'remote.invalid:8181');
    expect(() => parseWebAuthConfig(configured)).toThrow(/loopback/);
    expect(() => parseWebAuthConfig(emulator)).toThrow(/differs from the process/);
  });
  it.each([
    ['NODE_ENV', 'production'],
    ['VERCEL', '1'],
  ])('rejects emulator bypass through actual process %s', (key, value) => {
    vi.stubEnv(key, value);
    expect(() => parseWebAuthConfig(emulator)).toThrow(/outside production and Vercel/);
  });
});

describe('keyless Vercel workload identity', () => {
  it('exchanges only on demand and combines simultaneous calls', async () => {
    const connection = createWebAuth(configured);
    expect(connection.projectId).toBe(configured.FIREBASE_PROJECT_ID);
    expect(sdk.fromJSON).not.toHaveBeenCalled();
    expect(sdk.getVercelOidcToken).not.toHaveBeenCalled();
    expect(
      await Promise.all([connection.getToken(), connection.getToken(), connection.getToken()]),
    ).toEqual(Array(3).fill(bearer));
    expect(sdk.fromJSON).toHaveBeenCalledOnce();
    expect(sdk.getAccessToken).toHaveBeenCalledOnce();
    expect(sdk.getVercelOidcToken).toHaveBeenCalledWith({ audience: `https://${provider}` });
    expect(sdk.fromJSON.mock.calls[0][0]).toMatchObject({
      type: 'external_account',
      audience: `//${provider}`,
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      token_url: 'https://sts.googleapis.com/v1/token',
      service_account_impersonation_url:
        'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/catan-api@fixture-catan.iam.gserviceaccount.com:generateAccessToken',
      scopes: ['https://www.googleapis.com/auth/datastore'],
      transporterOptions: { timeout: 5_000, retryConfig: { retry: 0 } },
    });
    await connection.close();
  });
  it('reuses SDK access-token caching and obtains fresh Vercel subjects when SDK refreshes', async () => {
    const connection = createWebAuth(configured);
    await connection.getToken();
    sdk.getVercelOidcToken.mockResolvedValueOnce('rotated.subject.token');
    sdk.getAccessToken.mockImplementationOnce(async (options) => {
      expect(await options.subject_token_supplier.getSubjectToken()).toBe('rotated.subject.token');
      return { token: 'refreshed-access-token' };
    });
    expect(await connection.getToken()).toBe('refreshed-access-token');
    expect(sdk.fromJSON).toHaveBeenCalledOnce();
    expect(sdk.getVercelOidcToken).toHaveBeenCalledTimes(2);
    await connection.close();
  });
  it('fails closed outside Vercel without initializing or retrieving identity', async () => {
    const connection = createWebAuth({ ...configured, VERCEL: undefined });
    await expect(connection.getToken()).rejects.toThrow(/requires a Vercel runtime/);
    expect(sdk.fromJSON).not.toHaveBeenCalled();
    expect(sdk.getVercelOidcToken).not.toHaveBeenCalled();
    await connection.close();
  });
  it('recognizes the real Vercel process when a narrower environment object is passed', async () => {
    vi.stubEnv('VERCEL', '1');
    const connection = createWebAuth({ ...configured, VERCEL: undefined });
    expect(await connection.getToken()).toBe(bearer);
    await connection.close();
  });
  it.each([null, undefined, '', 'token\r\nheader', 'x'.repeat(16_385)])(
    'rejects malformed access tokens without returning data (%#)',
    async (token) => {
      sdk.getAccessToken.mockResolvedValueOnce({ token });
      const connection = createWebAuth(configured);
      await expect(connection.getToken()).rejects.toThrow(failure);
      await connection.close();
    },
  );
  it.each([undefined, '', 'bad token', 'x'.repeat(16_385)])(
    'rejects malformed Vercel subjects (%#)',
    async (subject) => {
      sdk.getVercelOidcToken.mockResolvedValueOnce(subject);
      const connection = createWebAuth(configured);
      await expect(connection.getToken()).rejects.toThrow(failure);
      await connection.close();
    },
  );
  it.each(['initialization', 'oidc', 'exchange'])(
    'sanitizes %s errors and permits recovery',
    async (stage) => {
      const secret = new Error('SECRET_RESPONSE_WITH_PRIVATE_TOKEN');
      if (stage === 'initialization')
        sdk.fromJSON.mockImplementationOnce(() => {
          throw secret;
        });
      if (stage === 'oidc') sdk.getVercelOidcToken.mockRejectedValueOnce(secret);
      if (stage === 'exchange') sdk.getAccessToken.mockRejectedValueOnce(secret);
      const connection = createWebAuth(configured);
      const error = await connection.getToken().catch((value: unknown) => value);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(failure);
      expect((error as Error).cause).toBeUndefined();
      expect(await connection.getToken()).toBe(bearer);
      await connection.close();
    },
  );
  it('sanitizes a failed SDK constructor returning no client', async () => {
    sdk.fromJSON.mockReturnValueOnce(null);
    const connection = createWebAuth(configured);
    await expect(connection.getToken()).rejects.toThrow(failure);
    await connection.close();
  });
  it('bounds a hung exchange and recovers while discarding a late result', async () => {
    vi.useFakeTimers();
    let resolve!: (value: { token: string }) => void;
    sdk.getAccessToken.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const connection = createWebAuth(configured);
    const first = connection.getToken();
    const rejection = expect(first).rejects.toThrow(failure);
    await vi.advanceTimersByTimeAsync(12_000);
    await rejection;
    expect(await connection.getToken()).toBe(bearer);
    resolve({ token: 'late-token-that-must-not-be-used' });
    await Promise.resolve();
    expect(sdk.setCredentials).toHaveBeenCalledWith({});
    await connection.close();
  });
  it('closes promptly during an in-flight exchange and never returns its late token', async () => {
    let resolve!: (value: { token: string }) => void;
    sdk.getAccessToken.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const connection = createWebAuth(configured);
    const pending = connection.getToken();
    const rejection = expect(pending).rejects.toThrow(closed);
    await connection.close();
    await rejection;
    resolve({ token: 'late-token-that-must-not-be-used' });
    await Promise.resolve();
    await expect(connection.getToken()).rejects.toThrow(closed);
    await connection.close();
  });
  it('refuses to start Google exchange when a pending subject token arrives after close', async () => {
    let resolve!: (value: string) => void;
    sdk.getVercelOidcToken.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const connection = createWebAuth(configured);
    const pending = connection.getToken();
    const rejection = expect(pending).rejects.toThrow(closed);
    await connection.close();
    resolve('late.subject.token');
    await rejection;
    await Promise.resolve();
  });
});
