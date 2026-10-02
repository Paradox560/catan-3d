import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  initializeApp: vi.fn(),
  deleteApp: vi.fn(),
  initializeAuth: vi.fn(),
  connectAuthEmulator: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  inMemoryPersistence: { type: 'NONE' },
}));
vi.mock('firebase/app', () => ({ initializeApp: sdk.initializeApp, deleteApp: sdk.deleteApp }));
vi.mock('firebase/auth', () => ({
  initializeAuth: sdk.initializeAuth,
  connectAuthEmulator: sdk.connectAuthEmulator,
  signInWithEmailAndPassword: sdk.signInWithEmailAndPassword,
  inMemoryPersistence: sdk.inMemoryPersistence,
}));

import { createWebAuth, parseWebAuthConfig } from './firebase-web-auth.js';

const configured: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  FIREBASE_API_KEY: 'fixture-api-key-never-a-real-key',
  FIREBASE_AUTH_DOMAIN: 'fixture-catan.firebaseapp.com',
  FIREBASE_PROJECT_ID: 'fixture-catan',
  FIREBASE_APP_ID: '1:123456789:web:012345abcdef',
  FIREBASE_BACKEND_EMAIL: 'backend@example.invalid',
  FIREBASE_BACKEND_PASSWORD: 'isolated-fixture-password',
  FIREBASE_BACKEND_UID: 'test-backend-uid',
};
const emulator = {
  ...configured,
  FIREBASE_PROJECT_ID: 'demo-catan-rankings',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8181',
};
const app = { name: 'mock-app' };
const auth = { app };
function result(overrides: Record<string, unknown> = {}) {
  return {
    token: 'fixture-bearer-never-a-real-token',
    claims: {
      aud: configured.FIREBASE_PROJECT_ID,
      iss: `https://securetoken.google.com/${configured.FIREBASE_PROJECT_ID}`,
      sub: configured.FIREBASE_BACKEND_UID,
      user_id: configured.FIREBASE_BACKEND_UID,
      exp: Math.floor(Date.now() / 1_000) + 3_600,
      ...overrides,
    },
  };
}
let getIdTokenResult: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('FIREBASE_AUTH_EMULATOR_HOST', undefined);
  vi.stubEnv('FIRESTORE_EMULATOR_HOST', undefined);
  sdk.initializeApp.mockReturnValue(app);
  sdk.initializeAuth.mockReturnValue(auth);
  sdk.deleteApp.mockResolvedValue(undefined);
  getIdTokenResult = vi.fn().mockResolvedValue(result());
  sdk.signInWithEmailAndPassword.mockResolvedValue({
    user: { uid: configured.FIREBASE_BACKEND_UID, getIdTokenResult },
  });
});
afterEach(() => vi.unstubAllEnvs());

describe('Firebase Console web configuration', () => {
  it('parses individual values synchronously without initializing the SDK or signing in', () => {
    const value = parseWebAuthConfig(configured);
    expect(value.options).toEqual({
      apiKey: configured.FIREBASE_API_KEY,
      authDomain: configured.FIREBASE_AUTH_DOMAIN,
      projectId: configured.FIREBASE_PROJECT_ID,
      appId: configured.FIREBASE_APP_ID,
    });
    expect(value.backend.uid).toBe(configured.FIREBASE_BACKEND_UID);
    expect(sdk.initializeApp).not.toHaveBeenCalled();
    expect(sdk.signInWithEmailAndPassword).not.toHaveBeenCalled();
  });
  it('accepts an unwrapped Console JSON object with optional fields', () => {
    const { backend } = parseWebAuthConfig(configured);
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
    const parsed = parseWebAuthConfig({
      FIREBASE_CONFIG: JSON.stringify(options),
      FIREBASE_BACKEND_EMAIL: backend.email,
      FIREBASE_BACKEND_PASSWORD: backend.password,
      FIREBASE_BACKEND_UID: backend.uid,
    });
    expect(parsed.options).toEqual(options);
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
    ['FIREBASE_BACKEND_EMAIL', undefined],
    ['FIREBASE_BACKEND_EMAIL', 'not-an-email'],
    ['FIREBASE_BACKEND_PASSWORD', undefined],
    ['FIREBASE_BACKEND_PASSWORD', 'short'],
    ['FIREBASE_BACKEND_UID', undefined],
    ['FIREBASE_BACKEND_UID', ' leading-space'],
    ['FIREBASE_BACKEND_UID', 'x'.repeat(129)],
    ['FIREBASE_MESSAGING_SENDER_ID', 'not-numeric'],
    ['FIREBASE_DATABASE_URL', 'http://untrusted.invalid'],
  ])('rejects invalid or missing %s (%#)', (key, value) => {
    expect(() => parseWebAuthConfig({ ...configured, [key as string]: value })).toThrow(
      key as string,
    );
  });
});

describe('isolated Auth and Firestore emulators', () => {
  it('accepts paired loopback endpoints only for nonproduction demo projects', () => {
    expect(parseWebAuthConfig(emulator).authEmulatorHost).toBe('127.0.0.1:9099');
    expect(
      parseWebAuthConfig({ ...emulator, FIREBASE_AUTH_EMULATOR_HOST: '[::1]:9099' })
        .authEmulatorHost,
    ).toBe('[::1]:9099');
  });
  it.each([
    { FIREBASE_AUTH_EMULATOR_HOST: undefined },
    { FIRESTORE_EMULATOR_HOST: undefined },
    { FIREBASE_PROJECT_ID: 'fixture-real-project' },
    { NODE_ENV: 'production' },
    { FIREBASE_AUTH_EMULATOR_HOST: 'https://localhost:9099' },
    { FIREBASE_AUTH_EMULATOR_HOST: 'remote.invalid:9099' },
    { FIRESTORE_EMULATOR_HOST: '127.0.0.1:0' },
    { FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:65536' },
  ])('rejects cloud/emulator mixing or unsafe endpoints (%#)', (values) => {
    expect(() => parseWebAuthConfig({ ...emulator, ...values })).toThrow();
  });
  it('rejects demo projects without both emulators', () => {
    expect(() => parseWebAuthConfig({ ...configured, FIREBASE_PROJECT_ID: 'demo-catan' })).toThrow(
      /both Firebase Auth and Firestore emulators/,
    );
  });
  it('validates inherited process emulator configuration and rejects mismatches', () => {
    vi.stubEnv('FIREBASE_AUTH_EMULATOR_HOST', 'remote.invalid:9099');
    expect(() => parseWebAuthConfig(configured)).toThrow(/loopback/);
    expect(() => parseWebAuthConfig(emulator)).toThrow(/differs from the process/);
  });
  it('rejects emulators when the actual process is production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => parseWebAuthConfig(emulator)).toThrow(/outside production/);
  });
  it('connects emulator Auth without console warnings before lazy sign-in', async () => {
    const connection = createWebAuth(emulator);
    expect(sdk.connectAuthEmulator).toHaveBeenCalledWith(auth, 'http://127.0.0.1:9099', {
      disableWarnings: true,
    });
    expect(sdk.signInWithEmailAndPassword).not.toHaveBeenCalled();
    await connection.close();
  });
});

describe('trusted backend authentication', () => {
  it('sanitizes SDK initialization failures', () => {
    sdk.initializeApp.mockImplementationOnce(() => {
      throw new Error('SECRET-INIT-VALUE');
    });
    expect(() => createWebAuth(configured)).toThrow(
      'Firebase backend authentication failed. Check the dedicated account, configured UID, and Firebase web configuration.',
    );
  });
  it('initializes in-memory identity and combines simultaneous sign-ins into one operation', async () => {
    const connection = createWebAuth(configured);
    expect(connection.projectId).toBe(configured.FIREBASE_PROJECT_ID);
    expect(sdk.initializeAuth).toHaveBeenCalledWith(app, { persistence: sdk.inMemoryPersistence });
    expect(sdk.signInWithEmailAndPassword).not.toHaveBeenCalled();
    const values = await Promise.all([
      connection.getToken(),
      connection.getToken(),
      connection.getToken(),
    ]);
    expect(values).toEqual(Array(3).fill('fixture-bearer-never-a-real-token'));
    expect(sdk.signInWithEmailAndPassword).toHaveBeenCalledTimes(1);
    expect(getIdTokenResult).toHaveBeenCalledTimes(1);
    await connection.close();
  });
  it('uses SDK refreshes on later requests without signing in again', async () => {
    const connection = createWebAuth(configured);
    await connection.getToken();
    getIdTokenResult.mockResolvedValueOnce({ ...result(), token: 'refreshed-fixture-token' });
    expect(await connection.getToken()).toBe('refreshed-fixture-token');
    expect(sdk.signInWithEmailAndPassword).toHaveBeenCalledTimes(1);
    expect(getIdTokenResult).toHaveBeenCalledTimes(2);
    await connection.close();
  });
  it('rejects the wrong signed-in UID before requesting its token', async () => {
    sdk.signInWithEmailAndPassword.mockResolvedValueOnce({
      user: { uid: 'wrong-account', getIdTokenResult },
    });
    const connection = createWebAuth(configured);
    await expect(connection.getToken()).rejects.toThrow(/configured UID/);
    expect(getIdTokenResult).not.toHaveBeenCalled();
    await connection.close();
  });
  it.each([
    { aud: 'wrong-project' },
    { aud: ['fixture-catan'] },
    { iss: 'https://securetoken.google.com/wrong-project' },
    { sub: 'wrong-account' },
    { user_id: 'wrong-account' },
    { exp: 1 },
    { exp: 'not-a-timestamp' },
  ])('rejects a token for a different project/account or an expired token (%#)', async (claims) => {
    getIdTokenResult.mockResolvedValueOnce(result(claims));
    const connection = createWebAuth(configured);
    await expect(connection.getToken()).rejects.toThrow(/backend authentication failed/);
    await connection.close();
  });
  it('sanitizes sign-in failures and allows a later request to retry', async () => {
    sdk.signInWithEmailAndPassword.mockRejectedValueOnce(new Error('SECRET-CONTENT-MUST-NOT-LEAK'));
    const connection = createWebAuth(configured);
    await expect(connection.getToken()).rejects.toThrow(
      'Firebase backend authentication failed. Check the dedicated account, configured UID, and Firebase web configuration.',
    );
    expect(await connection.getToken()).toBe('fixture-bearer-never-a-real-token');
    expect(sdk.signInWithEmailAndPassword).toHaveBeenCalledTimes(2);
    await connection.close();
  });
  it('sanitizes SDK refresh failures and never returns an old token', async () => {
    const connection = createWebAuth(configured);
    await connection.getToken();
    getIdTokenResult.mockRejectedValueOnce(new Error('SECRET-REFRESH-TOKEN'));
    await expect(connection.getToken()).rejects.toThrow(/backend authentication failed/);
    await connection.close();
  });
  it('closes once and prevents further token requests', async () => {
    const connection = createWebAuth(configured);
    await Promise.all([connection.close(), connection.close()]);
    expect(sdk.deleteApp).toHaveBeenCalledTimes(1);
    await expect(connection.getToken()).rejects.toThrow(/has been closed/);
  });
  it('prevents a pending sign-in from releasing a token after close', async () => {
    let finish!: (value: unknown) => void;
    sdk.signInWithEmailAndPassword.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const connection = createWebAuth(configured);
    const pending = connection.getToken();
    const closing = connection.close();
    finish({ user: { uid: configured.FIREBASE_BACKEND_UID, getIdTokenResult } });
    await expect(pending).rejects.toThrow(/backend authentication failed/);
    await closing;
    expect(getIdTokenResult).not.toHaveBeenCalled();
  });
});
