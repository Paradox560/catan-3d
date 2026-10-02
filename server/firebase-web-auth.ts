import { getVercelOidcToken } from '@vercel/oidc';
import type { FirebaseOptions } from 'firebase/app';
import { ExternalAccountClient, type BaseExternalAccountClient } from 'google-auth-library';

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
  projectNumber: string;
  workload: { audience: string; oidcAudience: string; serviceAccount: string };
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
  if (!options.appId || !/^1:[1-9][0-9]{0,19}:web:[a-zA-Z0-9]+$/.test(options.appId)) {
    throw new Error('Set FIREBASE_APP_ID to the Firebase Console web app ID.');
  }
  const projectNumber = options.appId.split(':')[1];
  if (options.messagingSenderId && options.messagingSenderId !== projectNumber) {
    throw new Error(
      'FIREBASE_MESSAGING_SENDER_ID must match the project number in FIREBASE_APP_ID.',
    );
  }
  if (options.databaseURL) {
    try {
      const url = new URL(options.databaseURL);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error();
    } catch {
      throw new Error('FIREBASE_DATABASE_URL must be an HTTPS Firebase database URL.');
    }
  }

  const firestoreEmulatorHost = emulatorHost(env, 'FIRESTORE_EMULATOR_HOST');
  // The old Auth emulator has no role in keyless Google identity. Reject an isolated
  // Auth emulator to prevent a local test accidentally reaching cloud Firestore.
  const authEmulatorHost = emulatorHost(env, 'FIREBASE_AUTH_EMULATOR_HOST');
  if (authEmulatorHost && !firestoreEmulatorHost) {
    throw new Error('Firebase Auth emulation cannot be mixed with cloud Firestore.');
  }
  if (firestoreEmulatorHost !== undefined) {
    if (
      env.NODE_ENV === 'production' ||
      process.env.NODE_ENV === 'production' ||
      env.VERCEL === '1' ||
      process.env.VERCEL === '1' ||
      !options.projectId.startsWith('demo-')
    ) {
      throw new Error(
        'Firestore emulation is allowed only outside production and Vercel with a demo- project ID.',
      );
    }
  } else if (options.projectId.startsWith('demo-')) {
    throw new Error('Demo Firebase projects require a loopback Firestore emulator.');
  }
  const provider = `iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/catan-vercel/providers/vercel`;
  return {
    options: options as RequiredWebOptions,
    projectNumber,
    workload: {
      audience: `//${provider}`,
      oidcAudience: `https://${provider}`,
      serviceAccount: `catan-api@${options.projectId}.iam.gserviceaccount.com`,
    },
    firestoreEmulatorHost,
  };
}

const AUTH_FAILURE =
  'Firebase keyless authentication failed. Check Vercel OIDC and the Google Cloud workload identity setup.';
const CLOSED = 'Firebase backend authentication has been closed.';
const VERCEL_REQUIRED =
  'Firebase keyless cloud access requires a Vercel runtime. Deploy to Vercel after the Google Cloud workload identity setup, or use a local demo Firestore emulator.';
const AUTH_TIMEOUT_MS = 12_000;

function validBearer(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= 16_384 && /^[A-Za-z0-9._~+/-]+=*$/.test(value)
  );
}

/** Public Firebase identifiers select the project; only Vercel's verified workload may access it. */
export function createWebAuth(env: NodeJS.ProcessEnv = process.env): WebAuth {
  const configuration = parseWebAuthConfig(env);
  const { options, workload, firestoreEmulatorHost } = configuration;
  const onVercel = env.VERCEL === '1' || process.env.VERCEL === '1';
  let client: BaseExternalAccountClient | undefined;
  let pending: Promise<string> | undefined;
  let cancelPending: (() => void) | undefined;
  let closed = false;

  function newClient(): BaseExternalAccountClient {
    const initialized = ExternalAccountClient.fromJSON({
      type: 'external_account',
      audience: workload.audience,
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      token_url: 'https://sts.googleapis.com/v1/token',
      service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${workload.serviceAccount}:generateAccessToken`,
      scopes: ['https://www.googleapis.com/auth/datastore'],
      // The whole operation below is additionally bounded because SDK-internal
      // STS calls and Vercel's subject-token exchange use separate transports.
      transporterOptions: { timeout: 5_000, retryConfig: { retry: 0 } },
      subject_token_supplier: {
        async getSubjectToken() {
          if (closed || client !== initialized) throw new Error(AUTH_FAILURE);
          // Always ask the SDK for the current trusted request identity. It handles
          // subject-token rotation; browser-supplied headers are never read here.
          const subject = await getVercelOidcToken({ audience: workload.oidcAudience });
          if (closed || client !== initialized || !validBearer(subject)) {
            throw new Error(AUTH_FAILURE);
          }
          return subject;
        },
      },
    });
    if (!initialized) throw new Error(AUTH_FAILURE);
    return initialized;
  }

  async function token(): Promise<string> {
    let active: BaseExternalAccountClient | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let exchange: Promise<{ token?: string | null }> | undefined;
    try {
      active = client ??= newClient();
      exchange = active.getAccessToken();
      const cancelled = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(AUTH_FAILURE)), AUTH_TIMEOUT_MS);
        cancelPending = () => reject(new Error(CLOSED));
      });
      const result = await Promise.race([exchange, cancelled]);
      if (closed || client !== active || !validBearer(result.token)) {
        throw new Error(AUTH_FAILURE);
      }
      return result.token;
    } catch {
      // An expired or failed identity can recover on the next request. A retired
      // SDK client cannot supply or publish a token after timeout or shutdown.
      if (client === active) client = undefined;
      active?.setCredentials({});
      if (active && exchange) {
        const discarded = active;
        void exchange
          .then(
            () => discarded.setCredentials({}),
            () => discarded.setCredentials({}),
          )
          .catch(() => {});
      }
      throw new Error(closed ? CLOSED : AUTH_FAILURE);
    } finally {
      if (timer) clearTimeout(timer);
      cancelPending = undefined;
    }
  }

  return {
    projectId: options.projectId,
    getToken() {
      if (closed) return Promise.reject(new Error(CLOSED));
      if (firestoreEmulatorHost) return Promise.resolve('owner');
      if (!onVercel) return Promise.reject(new Error(VERCEL_REQUIRED));
      pending ??= token().finally(() => {
        pending = undefined;
      });
      return pending;
    },
    async close() {
      closed = true;
      cancelPending?.();
      await pending?.catch(() => {});
      client?.setCredentials({});
      client = undefined;
    },
  };
}
