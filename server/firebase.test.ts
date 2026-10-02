import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRankingsFirestore } from './firebase';

const configured = {
  NODE_ENV: 'test',
  FIREBASE_PROJECT_ID: 'inventory-management-6626b',
  FIRESTORE_RANKINGS_DOCUMENT: 'catan/rankings',
};

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('FIRESTORE_EMULATOR_HOST', undefined);
  vi.stubEnv('FIREBASE_AUTH_EMULATOR_HOST', undefined);
});

describe('Web-config Firestore factory', () => {
  const web = {
    ...configured,
    FIREBASE_API_KEY: 'isolated-test-api-key',
    FIREBASE_PROJECT_ID: 'demo-catan-web',
    FIREBASE_AUTH_DOMAIN: 'demo-catan-web.firebaseapp.com',
    FIREBASE_APP_ID: '1:123456:web:abcdef123456',
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:8181',
  };

  it('selects web authentication without a service-account credential', async () => {
    const connection = createRankingsFirestore(web);
    expect(connection.documentPath).toBe('catan/rankings');
    expect(connection.firestore.doc('catan/rankings').path).toBe('catan/rankings');
    await Promise.all([connection.close(), connection.close()]);
  });

  it('uses the existing ledger by default without additional storage configuration', async () => {
    const connection = createRankingsFirestore({ ...web, FIRESTORE_RANKINGS_DOCUMENT: undefined });
    expect(connection.documentPath).toBe('catan/rankings');
    await connection.close();
  });

  it('accepts the Console web config as one JSON variable', async () => {
    const {
      FIREBASE_API_KEY,
      FIREBASE_AUTH_DOMAIN,
      FIREBASE_PROJECT_ID,
      FIREBASE_APP_ID,
      ...rest
    } = web;
    const connection = createRankingsFirestore({
      ...rest,
      FIREBASE_CONFIG: JSON.stringify({
        apiKey: FIREBASE_API_KEY,
        authDomain: FIREBASE_AUTH_DOMAIN,
        projectId: FIREBASE_PROJECT_ID,
        appId: FIREBASE_APP_ID,
      }),
    });
    expect(connection.documentPath).toBe('catan/rankings');
    await connection.close();
  });

  it.each(['FIREBASE_SERVICE_ACCOUNT_JSON', 'GOOGLE_APPLICATION_CREDENTIALS'])(
    'rejects a leftover Admin source %s in web mode',
    (source) => {
      expect(() => createRankingsFirestore({ ...web, [source]: '' })).toThrow(
        /Remove service-account/,
      );
    },
  );

  it('does not fall back to Admin when web configuration is incomplete', () => {
    expect(() => createRankingsFirestore({ ...configured, FIREBASE_AUTH_MODE: 'web' })).toThrow(
      /FIREBASE_API_KEY/,
    );
  });

  it('rejects an unknown authentication mode', () => {
    expect(() => createRankingsFirestore({ ...web, FIREBASE_AUTH_MODE: 'unknown' })).toThrow(
      /FIREBASE_AUTH_MODE/,
    );
  });
});
afterEach(() => vi.unstubAllEnvs());

describe('Firebase configuration', () => {
  it.each([undefined, '', 'bad/project'])('rejects missing or invalid project ID %s', (project) => {
    expect(() => createRankingsFirestore({ ...configured, FIREBASE_PROJECT_ID: project })).toThrow(
      /FIREBASE_PROJECT_ID/,
    );
  });

  it.each([
    undefined,
    '',
    'catan',
    '/catan/rankings',
    'catan/rankings/',
    'catan//rankings/x',
    'catan/..',
    'catan/__reserved__',
  ])('rejects invalid document path %s', (document) => {
    expect(() =>
      createRankingsFirestore({ ...configured, FIRESTORE_RANKINGS_DOCUMENT: document }),
    ).toThrow(/collection\/document/);
  });

  it('does not include invalid credential contents in errors', () => {
    const secret = 'this-private-value-must-not-be-returned';
    expect(() =>
      createRankingsFirestore({ ...configured, FIREBASE_SERVICE_ACCOUNT_JSON: secret }),
    ).toThrow('Firebase service-account credentials must be valid JSON.');
  });

  it('rejects Firebase web keys instead of service credentials', () => {
    expect(() =>
      createRankingsFirestore({
        ...configured,
        FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
          apiKey: 'web-key',
          projectId: configured.FIREBASE_PROJECT_ID,
        }),
      }),
    ).toThrow(/not a web API key/);
  });

  it('rejects a credential for a different Firebase project before parsing its key', () => {
    expect(() =>
      createRankingsFirestore({
        ...configured,
        FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
          type: 'service_account',
          project_id: 'another-project',
          client_email: 'test@example.invalid',
          private_key: 'private-value',
        }),
      }),
    ).toThrow(/project does not match/);
  });

  it('rejects an invalid private key without exposing it', () => {
    expect(() =>
      createRankingsFirestore({
        ...configured,
        FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
          type: 'service_account',
          project_id: configured.FIREBASE_PROJECT_ID,
          client_email: 'test@example.invalid',
          private_key: 'private-value',
        }),
      }),
    ).toThrow('The Firebase service-account key is invalid. Supply the original downloaded JSON.');
  });

  it('reads only the specified credential file and validates its project', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'catan-firebase-config-'));
    const filename = path.join(directory, 'service-account.json');
    try {
      writeFileSync(
        filename,
        JSON.stringify({
          type: 'service_account',
          project_id: 'another-project',
          client_email: 'test@example.invalid',
          private_key: 'private-value',
        }),
        { mode: 0o600 },
      );
      expect(() =>
        createRankingsFirestore({ ...configured, GOOGLE_APPLICATION_CREDENTIALS: filename }),
      ).toThrow(/project does not match/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects unreadable credential files and ambiguous credential sources', () => {
    expect(() =>
      createRankingsFirestore({
        ...configured,
        GOOGLE_APPLICATION_CREDENTIALS: '/does-not-exist/catan-key.json',
      }),
    ).toThrow(/Cannot read GOOGLE_APPLICATION_CREDENTIALS/);
    expect(() =>
      createRankingsFirestore({
        ...configured,
        FIREBASE_SERVICE_ACCOUNT_JSON: '{}',
        GOOGLE_APPLICATION_CREDENTIALS: '/does-not-exist/catan-key.json',
      }),
    ).toThrow(/not both/);
  });

  it('refuses to send a real project to an emulator', () => {
    expect(() =>
      createRankingsFirestore({ ...configured, FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }),
    ).toThrow(/demo-/);
  });

  it('refuses to send a demo project to the cloud', () => {
    expect(() =>
      createRankingsFirestore({ ...configured, FIREBASE_PROJECT_ID: 'demo-catan-rankings' }),
    ).toThrow(/require FIRESTORE_EMULATOR_HOST/);
  });

  it('refuses emulation in production', () => {
    expect(() =>
      createRankingsFirestore({
        ...configured,
        NODE_ENV: 'production',
        FIREBASE_PROJECT_ID: 'demo-catan-rankings',
        FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
      }),
    ).toThrow(/outside production/);
  });

  it('validates the global emulator variable even with an injected environment', () => {
    vi.stubEnv('FIRESTORE_EMULATOR_HOST', '127.0.0.1:8080');
    expect(() => createRankingsFirestore(configured)).toThrow(/demo-/);
  });

  it('rejects conflicting emulator hosts because the SDK reads the process environment', () => {
    vi.stubEnv('FIRESTORE_EMULATOR_HOST', 'remote.invalid:8080');
    expect(() =>
      createRankingsFirestore({
        ...configured,
        FIREBASE_PROJECT_ID: 'demo-catan-rankings',
        FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
      }),
    ).toThrow(/differs from the process environment/);
  });

  it.each(['https://localhost:8080', 'example.com:8080', '127.0.0.1:0', '127.0.0.1:99999'])(
    'rejects an unsafe or invalid emulator address %s',
    (host) => {
      expect(() =>
        createRankingsFirestore({
          ...configured,
          FIREBASE_PROJECT_ID: 'demo-catan-rankings',
          FIRESTORE_EMULATOR_HOST: host,
        }),
      ).toThrow(/FIRESTORE_EMULATOR_HOST/);
    },
  );

  it('creates separate emulator clients and closes them without cloud credentials', async () => {
    const env = {
      ...configured,
      FIREBASE_PROJECT_ID: 'demo-catan-rankings',
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
    };
    const first = createRankingsFirestore(env);
    const second = createRankingsFirestore(env);
    expect(first.documentPath).toBe('catan/rankings');
    expect(second.firestore).not.toBe(first.firestore);
    await Promise.all([first.close(), first.close(), second.close()]);
  });
});
