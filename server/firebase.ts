import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  applicationDefault,
  cert,
  deleteApp,
  initializeApp,
  type Credential,
} from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

export interface RankingsFirestore {
  firestore: Firestore;
  documentPath: string;
  close(): Promise<void>;
}

function serviceAccountCredential(contents: string, projectId: string): Credential {
  let account: unknown;
  try {
    account = JSON.parse(contents);
  } catch {
    throw new Error('Firebase service-account credentials must be valid JSON.');
  }
  if (
    !account ||
    typeof account !== 'object' ||
    !('type' in account) ||
    account.type !== 'service_account' ||
    !('project_id' in account) ||
    typeof account.project_id !== 'string' ||
    !('client_email' in account) ||
    typeof account.client_email !== 'string' ||
    !('private_key' in account) ||
    typeof account.private_key !== 'string'
  ) {
    throw new Error('Supply a Firebase Admin service-account JSON key, not a web API key.');
  }
  if (account.project_id !== projectId) {
    throw new Error('The Firebase service-account project does not match FIREBASE_PROJECT_ID.');
  }
  try {
    return cert({
      projectId: account.project_id,
      clientEmail: account.client_email,
      privateKey: account.private_key,
    });
  } catch {
    throw new Error(
      'The Firebase service-account key is invalid. Supply the original downloaded JSON.',
    );
  }
}

export function createRankingsFirestore(env: NodeJS.ProcessEnv = process.env): RankingsFirestore {
  const projectId = env.FIREBASE_PROJECT_ID?.trim();
  if (!projectId || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) {
    throw new Error('Set FIREBASE_PROJECT_ID to the Firebase project ID before using Firestore.');
  }

  const documentPath = env.FIRESTORE_RANKINGS_DOCUMENT?.trim();
  const segments = documentPath?.split('/') ?? [];
  if (
    !documentPath ||
    segments.length % 2 !== 0 ||
    segments.length > 100 ||
    segments.some(
      (part) =>
        !part.trim() ||
        part === '.' ||
        part === '..' ||
        /^__.*__$/.test(part) ||
        Buffer.byteLength(part, 'utf8') > 1_500,
    )
  ) {
    throw new Error(
      'Set FIRESTORE_RANKINGS_DOCUMENT to a collection/document path, such as catan/rankings.',
    );
  }

  const databaseId = env.FIRESTORE_DATABASE_ID?.trim() ?? '(default)';
  if (
    !databaseId ||
    (databaseId !== '(default)' && !/^[a-z][a-z0-9-]{2,61}[a-z0-9]$/.test(databaseId))
  ) {
    throw new Error(
      'FIRESTORE_DATABASE_ID must be (default) or a valid named Firestore database ID.',
    );
  }

  // The SDK also reads this global variable; validate it even with injected config.
  const emulatorHost = env.FIRESTORE_EMULATOR_HOST ?? process.env.FIRESTORE_EMULATOR_HOST;
  if (
    env.FIRESTORE_EMULATOR_HOST !== undefined &&
    process.env.FIRESTORE_EMULATOR_HOST !== undefined &&
    env.FIRESTORE_EMULATOR_HOST !== process.env.FIRESTORE_EMULATOR_HOST
  ) {
    throw new Error('The configured FIRESTORE_EMULATOR_HOST differs from the process environment.');
  }
  if (emulatorHost !== undefined) {
    if (
      env.NODE_ENV === 'production' ||
      process.env.NODE_ENV === 'production' ||
      !projectId.startsWith('demo-')
    ) {
      throw new Error(
        'Firestore emulation is allowed only outside production with a demo- project ID.',
      );
    }
    if (!/^(?:127\.0\.0\.1|localhost|\[::1\]):[0-9]{1,5}$/.test(emulatorHost)) {
      throw new Error(
        'FIRESTORE_EMULATOR_HOST must be a loopback host and port without a URL scheme.',
      );
    }
    const port = Number(emulatorHost.slice(emulatorHost.lastIndexOf(':') + 1));
    if (port < 1 || port > 65_535) {
      throw new Error('FIRESTORE_EMULATOR_HOST must contain a valid port.');
    }
  } else if (projectId.startsWith('demo-')) {
    throw new Error('Demo Firebase projects require FIRESTORE_EMULATOR_HOST.');
  }

  let credential: Credential;
  const secretJson = env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const credentialPath = env.GOOGLE_APPLICATION_CREDENTIALS;
  if (secretJson !== undefined && credentialPath !== undefined) {
    throw new Error(
      'Set either FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS, not both.',
    );
  }
  if (emulatorHost !== undefined) {
    // ssl:false makes the Firestore client use emulator credentials, without ADC lookup.
    credential = applicationDefault();
  } else if (secretJson !== undefined) {
    credential = serviceAccountCredential(secretJson, projectId);
  } else if (credentialPath !== undefined) {
    let contents: string;
    try {
      contents = readFileSync(credentialPath, 'utf8');
    } catch {
      throw new Error(
        'Cannot read GOOGLE_APPLICATION_CREDENTIALS. Supply a readable service-account JSON file.',
      );
    }
    credential = serviceAccountCredential(contents, projectId);
  } else {
    // Google-managed runtimes use their assigned service identity. Missing ADC causes
    // the first database request to fail; the storage layer never falls back to files.
    credential = applicationDefault();
  }

  const app = initializeApp({ projectId, credential }, `catan-rankings-${randomUUID()}`);
  const firestore = databaseId === '(default)' ? getFirestore(app) : getFirestore(app, databaseId);
  if (emulatorHost !== undefined) firestore.settings({ host: emulatorHost, ssl: false });
  let closing: Promise<void> | undefined;
  return {
    firestore,
    documentPath,
    close() {
      closing ??= (async () => {
        try {
          await firestore.terminate();
        } finally {
          await deleteApp(app);
        }
      })();
      return closing;
    },
  };
}
