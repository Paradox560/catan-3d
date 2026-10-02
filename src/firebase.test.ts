import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  getApps: vi.fn(),
  initializeApp: vi.fn(),
  getAuth: vi.fn(),
  getFirestore: vi.fn(),
  setPersistence: vi.fn(),
  authStateReady: vi.fn(),
  session: { type: 'SESSION' },
}));
vi.mock('firebase/app', () => ({ getApps: sdk.getApps, initializeApp: sdk.initializeApp }));
vi.mock('firebase/auth', () => ({
  getAuth: sdk.getAuth,
  setPersistence: sdk.setPersistence,
  browserSessionPersistence: sdk.session,
}));
vi.mock('firebase/firestore', () => ({ getFirestore: sdk.getFirestore }));
import { parseFirebaseConfig } from './firebase';
const config = {
  VITE_FIREBASE_API_KEY: 'fixture-web-key',
  VITE_FIREBASE_AUTH_DOMAIN: 'demo-catan.firebaseapp.com',
  VITE_FIREBASE_PROJECT_ID: 'demo-catan',
  VITE_FIREBASE_APP_ID: '1:123456789:web:abcdef123456',
};
beforeEach(() => {
  vi.resetAllMocks();
  sdk.getApps.mockReturnValue([]);
  sdk.initializeApp.mockReturnValue({ name: 'catan-rankings-browser' });
  sdk.getFirestore.mockReturnValue({ name: 'firestore' });
  sdk.getAuth.mockReturnValue({ authStateReady: sdk.authStateReady });
  sdk.setPersistence.mockResolvedValue(undefined);
  sdk.authStateReady.mockResolvedValue(undefined);
});

describe('standard public Firebase browser configuration', () => {
  it('accepts the four required and three optional Console fields', () => {
    expect(
      parseFirebaseConfig({
        ...config,
        VITE_FIREBASE_STORAGE_BUCKET: 'demo-catan.firebasestorage.app',
        VITE_FIREBASE_MESSAGING_SENDER_ID: '123456789',
        VITE_FIREBASE_MEASUREMENT_ID: 'G-EXAMPLE',
      }),
    ).toEqual({
      apiKey: 'fixture-web-key',
      authDomain: 'demo-catan.firebaseapp.com',
      projectId: 'demo-catan',
      appId: '1:123456789:web:abcdef123456',
      storageBucket: 'demo-catan.firebasestorage.app',
      messagingSenderId: '123456789',
      measurementId: 'G-EXAMPLE',
    });
  });
  it('never includes backend credentials or arbitrary public environment variables', () => {
    const parsed = parseFirebaseConfig({
      ...config,
      FIREBASE_SERVICE_ACCOUNT_JSON: 'private-value',
      RANKINGS_ADMIN_PASSWORD: 'private-password',
      VITE_FIREBASE_BACKEND_PASSWORD: 'accidentally-public',
    });
    expect(Object.keys(parsed)).toEqual(['apiKey', 'authDomain', 'projectId', 'appId']);
    expect(JSON.stringify(parsed)).not.toContain('private');
  });
  it.each([
    ['VITE_FIREBASE_API_KEY', undefined],
    ['VITE_FIREBASE_AUTH_DOMAIN', 'https://bad.invalid'],
    ['VITE_FIREBASE_PROJECT_ID', 'bad/project'],
    ['VITE_FIREBASE_APP_ID', 'not-an-app-id'],
    ['VITE_FIREBASE_MESSAGING_SENDER_ID', 'different-project'],
    ['VITE_FIREBASE_API_KEY', '\nsecret-value'],
  ])('rejects invalid %s without including its value', (key, value) => {
    expect(() => parseFirebaseConfig({ ...config, [key]: value })).toThrow(
      'Set the Firebase web app configuration in Vercel and redeploy to connect the shared rankings.',
    );
  });
  it('initializes once using session persistence before exposing ready authentication', async () => {
    vi.resetModules();
    for (const [key, value] of Object.entries(config)) vi.stubEnv(key, value);
    const { getFirebaseServices } = await import('./firebase');
    expect(sdk.initializeApp).not.toHaveBeenCalled();
    const first = getFirebaseServices();
    expect(getFirebaseServices()).toBe(first);
    await first.ready;
    expect(sdk.initializeApp).toHaveBeenCalledOnce();
    expect(sdk.getFirestore).toHaveBeenCalledOnce();
    expect(sdk.setPersistence).toHaveBeenCalledWith(first.auth, sdk.session);
    expect(sdk.authStateReady).toHaveBeenCalledOnce();
    vi.unstubAllEnvs();
  });
});
