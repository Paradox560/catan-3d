import { randomUUID } from 'node:crypto';
import { deleteApp, initializeApp, type FirebaseOptions } from 'firebase/app';
import {
  connectAuthEmulator,
  initializeAuth,
  inMemoryPersistence,
  signInWithEmailAndPassword,
  type User,
} from 'firebase/auth';

const PUBLIC_FIELDS = {
  apiKey: 'FIREBASE_API_KEY',
  authDomain: 'FIREBASE_AUTH_DOMAIN',
  projectId: 'FIREBASE_PROJECT_ID',
  appId: 'FIREBASE_APP_ID',
  storageBucket: 'FIREBASE_STORAGE_BUCKET',
  messagingSenderId: 'FIREBASE_MESSAGING_SENDER_ID',
  measurementId: 'FIREBASE_MEASUREMENT_ID',
  databaseURL: 'FIREBASE_DATABASE_URL',
} as const;

type RequiredWebOptions = FirebaseOptions & {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
};
export interface WebAuthConfig {
  options: RequiredWebOptions;
  backend: { email: string; password: string; uid: string };
  authEmulatorHost?: string;
  firestoreEmulatorHost?: string;
}
export interface WebAuth {
  projectId: string;
  getToken(): Promise<string>;
  close(): Promise<void>;
}

function emulatorHost(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const configured = env[name];
  const global = process.env[name];
  if (configured !== undefined && global !== undefined && configured !== global) {
    throw new Error(`The configured ${name} differs from the process environment.`);
  }
  const host = configured ?? global;
  if (host === undefined) return undefined;
  if (!/^(?:127\.0\.0\.1|localhost|\[::1\]):[0-9]{1,5}$/.test(host)) {
    throw new Error(`${name} must be a loopback host and port without a URL scheme.`);
  }
  const port = Number(host.slice(host.lastIndexOf(':') + 1));
  if (port < 1 || port > 65_535) throw new Error(`${name} must contain a valid port.`);
  return host;
}

/** Validate configuration without opening a network connection or exposing configuration values. */
export function parseWebAuthConfig(env: NodeJS.ProcessEnv = process.env): WebAuthConfig {
  let input: Record<string, unknown>;
  if (env.FIREBASE_CONFIG !== undefined) {
    if (Object.values(PUBLIC_FIELDS).some((name) => env[name] !== undefined)) {
      throw new Error(
        'Use FIREBASE_CONFIG or individual Firebase web configuration variables, not both.',
      );
    }
    try {
      const parsed: unknown = JSON.parse(env.FIREBASE_CONFIG);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      input = parsed as Record<string, unknown>;
    } catch {
      throw new Error(
        'FIREBASE_CONFIG must contain the Firebase Console web configuration as a JSON object.',
      );
    }
  } else {
    input = Object.fromEntries(
      Object.entries(PUBLIC_FIELDS).map(([key, name]) => [key, env[name]]),
    );
  }
  const options: FirebaseOptions = {};
  for (const [key, name] of Object.entries(PUBLIC_FIELDS)) {
    const value = input[key];
    if (value === undefined) continue;
    if (
      typeof value !== 'string' ||
      !value.trim() ||
      value.length > 2_048 ||
      /[\u0000-\u001f\u007f]/.test(value)
    ) {
      throw new Error(`Set ${name} to the corresponding Firebase Console web configuration value.`);
    }
    options[key as keyof FirebaseOptions] = value.trim();
  }
  if (!options.apiKey || !/^[A-Za-z0-9_-]{6,256}$/.test(options.apiKey)) {
    throw new Error('Set FIREBASE_API_KEY to the Firebase Console web API key.');
  }
  if (!options.projectId || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(options.projectId)) {
    throw new Error('Set FIREBASE_PROJECT_ID to the Firebase project ID.');
  }
  if (
    !options.authDomain ||
    !/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/.test(options.authDomain)
  ) {
    throw new Error(
      'Set FIREBASE_AUTH_DOMAIN to the Firebase Console authDomain hostname, without a URL scheme.',
    );
  }
  if (!options.appId || !/^1:[0-9]+:web:[a-zA-Z0-9]+$/.test(options.appId)) {
    throw new Error('Set FIREBASE_APP_ID to the Firebase Console web app ID.');
  }
  if (options.messagingSenderId && !/^[0-9]+$/.test(options.messagingSenderId)) {
    throw new Error('FIREBASE_MESSAGING_SENDER_ID must contain the Firebase messaging sender ID.');
  }
  if (options.databaseURL) {
    try {
      const url = new URL(options.databaseURL);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error();
    } catch {
      throw new Error('FIREBASE_DATABASE_URL must be an HTTPS Firebase database URL.');
    }
  }

  const email = env.FIREBASE_BACKEND_EMAIL?.trim();
  const password = env.FIREBASE_BACKEND_PASSWORD;
  const uid = env.FIREBASE_BACKEND_UID;
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(
      'Set FIREBASE_BACKEND_EMAIL to the dedicated Firebase Authentication account email.',
    );
  }
  if (!password || password.length < 6 || password.length > 4_096) {
    throw new Error(
      'Set FIREBASE_BACKEND_PASSWORD to the dedicated account password (6–4,096 characters).',
    );
  }
  if (!uid || uid !== uid.trim() || uid.length > 128 || /[\u0000-\u001f\u007f]/.test(uid)) {
    throw new Error(
      'Set FIREBASE_BACKEND_UID to the dedicated Firebase Authentication account UID.',
    );
  }
  const authEmulatorHost = emulatorHost(env, 'FIREBASE_AUTH_EMULATOR_HOST');
  const firestoreEmulatorHost = emulatorHost(env, 'FIRESTORE_EMULATOR_HOST');
  if ((authEmulatorHost !== undefined) !== (firestoreEmulatorHost !== undefined)) {
    throw new Error(
      'Configure both Firebase Auth and Firestore emulators together; mixing emulator and cloud services is disabled.',
    );
  }
  if (authEmulatorHost !== undefined) {
    if (
      env.NODE_ENV === 'production' ||
      process.env.NODE_ENV === 'production' ||
      !options.projectId.startsWith('demo-')
    ) {
      throw new Error(
        'Firebase emulators are allowed only outside production with a demo- project ID.',
      );
    }
  } else if (options.projectId.startsWith('demo-')) {
    throw new Error('Demo Firebase projects require both Firebase Auth and Firestore emulators.');
  }
  return {
    options: options as RequiredWebOptions,
    backend: { email, password, uid },
    authEmulatorHost,
    firestoreEmulatorHost,
  };
}

const AUTH_FAILURE =
  'Firebase backend authentication failed. Check the dedicated account, configured UID, and Firebase web configuration.';

/** This identity belongs only to the trusted backend, never the browser owner sign-in. */
export function createWebAuth(env: NodeJS.ProcessEnv = process.env): WebAuth {
  const configuration = parseWebAuthConfig(env);
  const { options, backend } = configuration;
  let app: ReturnType<typeof initializeApp>;
  try {
    app = initializeApp(options, `catan-backend-${randomUUID()}`);
  } catch {
    throw new Error(AUTH_FAILURE);
  }
  let auth: ReturnType<typeof initializeAuth>;
  try {
    auth = initializeAuth(app, { persistence: inMemoryPersistence });
    if (configuration.authEmulatorHost) {
      connectAuthEmulator(auth, `http://${configuration.authEmulatorHost}`, {
        disableWarnings: true,
      });
    }
  } catch {
    void deleteApp(app).catch(() => {});
    throw new Error(AUTH_FAILURE);
  }
  let user: User | null = null;
  let pending: Promise<string> | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;

  async function token(): Promise<string> {
    try {
      if (!user) {
        const signedIn = await signInWithEmailAndPassword(auth, backend.email, backend.password);
        if (signedIn.user.uid !== backend.uid) throw new Error();
        user = signedIn.user;
      }
      if (closed || user.uid !== backend.uid) throw new Error();
      // The SDK refreshes expiring tokens; never cache a raw bearer token ourselves.
      const result = await user.getIdTokenResult();
      const claims = result.claims;
      if (
        closed ||
        typeof result.token !== 'string' ||
        !result.token ||
        claims.aud !== options.projectId ||
        claims.iss !== `https://securetoken.google.com/${options.projectId}` ||
        claims.sub !== backend.uid ||
        (claims.user_id !== undefined && claims.user_id !== backend.uid) ||
        typeof claims.exp !== 'number' ||
        !Number.isFinite(claims.exp) ||
        claims.exp <= Date.now() / 1_000
      )
        throw new Error();
      return result.token;
    } catch {
      user = null;
      throw new Error(AUTH_FAILURE);
    }
  }
  return {
    projectId: options.projectId,
    getToken() {
      if (closed)
        return Promise.reject(new Error('Firebase backend authentication has been closed.'));
      pending ??= token().finally(() => {
        pending = undefined;
      });
      return pending;
    },
    close() {
      closed = true;
      closing ??= (async () => {
        await pending?.catch(() => {});
        user = null;
        try {
          await deleteApp(app);
        } catch {
          throw new Error('Firebase backend authentication could not be closed.');
        }
      })();
      return closing;
    },
  };
}
