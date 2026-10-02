import express, { type Request, type Response } from 'express';
import { randomBytes, createHash, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { validateRankings, type RankingsData } from '../src/rankings/model';
import { createRankingsStore } from './rankings-storage';
import { RankingsConflictError, RankingsStorageError, type RankingsStore } from './rankings-store';

interface Credentials {
  version: 1;
  salt: string;
  hash: string;
}
interface Session {
  expires: number;
}
const COOKIE = 'catan_rankings_owner';
const SESSION_LIFETIME = 12 * 60 * 60 * 1_000;
const PASSWORD_MINIMUM = 10;
const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
const isLoopback = (address: string | undefined): boolean =>
  address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
const localHost = (host: string): boolean => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);

function atomicJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function password(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < PASSWORD_MINIMUM ||
    Buffer.byteLength(value, 'utf8') > 1_024
  ) {
    throw new Error('Use an owner password of at least 10 characters (at most 1,024 bytes).');
  }
  return value;
}
function makeCredentials(secret: string): Credentials {
  const salt = randomBytes(32).toString('hex');
  return { version: 1, salt, hash: scryptSync(secret, salt, 64).toString('hex') };
}
function readCredentials(file: string): Credentials {
  const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<Credentials>;
  if (
    value?.version !== 1 ||
    typeof value.salt !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.salt) ||
    typeof value.hash !== 'string' ||
    !/^[a-f0-9]{128}$/.test(value.hash)
  ) {
    throw new Error('Invalid owner credential file.');
  }
  return value as Credentials;
}
function matches(secret: string, credentials: Credentials): Promise<boolean> {
  return new Promise((resolve, reject) => {
    scrypt(secret, credentials.salt, 64, (error, derived) => {
      if (error) reject(error);
      else resolve(timingSafeEqual(derived, Buffer.from(credentials.hash, 'hex')));
    });
  });
}

/** Public rankings and authenticated owner editing. This ledger never expires with game rooms. */
export function rankingsRouter(dataDir: string): express.Router {
  const router = express.Router();
  const production = process.env.NODE_ENV === 'production';
  const credentialsFile = path.join(dataDir, 'rankings-admin.json');
  let store: RankingsStore;
  let credentials: Credentials | null = null;
  let unavailable: string | null = null;
  const sessions = new Map<string, Session>();
  const attempts = new Map<string, { count: number; reset: number }>();
  let pendingLogins = 0;

  const storageReady = createRankingsStore(dataDir)
    .then((value) => {
      store = value;
    })
    .catch((error: unknown) => {
      unavailable =
        error instanceof RankingsStorageError
          ? error.message
          : 'Rankings storage could not be initialized. Check the server configuration.';
      console.error('Rankings storage is unavailable. Check its server configuration.');
    });
  try {
    if (process.env.RANKINGS_ADMIN_PASSWORD !== undefined) {
      credentials = makeCredentials(password(process.env.RANKINGS_ADMIN_PASSWORD));
    } else if (existsSync(credentialsFile)) {
      credentials = readCredentials(credentialsFile);
      chmodSync(credentialsFile, 0o600);
    }
  } catch {
    unavailable ??=
      'Owner authentication is unavailable. Check RANKINGS_ADMIN_PASSWORD or restore rankings-admin.json; existing files have been preserved.';
    console.error('Rankings owner authentication is unavailable: check its configuration.');
  }

  function storageFailure(res: Response, error: unknown): void {
    res.status(503).json({
      error:
        error instanceof RankingsStorageError
          ? error.message
          : 'The rankings store is unavailable. Check its connection and credentials, then retry. No local fallback has been used.',
    });
  }

  function canSetup(req: Request): boolean {
    return (
      !production &&
      !credentials &&
      !unavailable &&
      isLoopback(req.socket.remoteAddress) &&
      localHost(req.get('host') ?? '') &&
      (!req.get('x-forwarded-for') ||
        req
          .get('x-forwarded-for')!
          .split(',')
          .every((address) => isLoopback(address.trim()))) &&
      (!req.get('x-forwarded-host') || localHost(req.get('x-forwarded-host')!))
    );
  }
  function sessionKey(req: Request): string | null {
    const value = req.headers.cookie
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1);
    return value && /^[a-f0-9]{64}$/.test(value) ? hashToken(value) : null;
  }
  function authenticated(req: Request): boolean {
    const now = Date.now();
    for (const [key, session] of sessions) if (session.expires <= now) sessions.delete(key);
    const key = sessionKey(req);
    return !!key && sessions.has(key);
  }
  async function payload(req: Request) {
    return {
      data: await store.read(),
      access: {
        authenticated: authenticated(req),
        configured: !!credentials,
        canSetup: canSetup(req),
      },
    };
  }
  async function issueSession(req: Request, res: Response): Promise<void> {
    const data = await store.read();
    const previous = sessionKey(req);
    if (previous) sessions.delete(previous);
    while (sessions.size >= 64) sessions.delete(sessions.keys().next().value!);
    const token = randomBytes(32).toString('hex');
    sessions.set(hashToken(token), { expires: Date.now() + SESSION_LIFETIME });
    res.cookie(COOKIE, token, {
      httpOnly: true,
      secure: production,
      sameSite: 'strict',
      path: '/api/rankings',
      maxAge: SESSION_LIFETIME,
    });
    // The new cookie belongs to the next request; return the new access state immediately.
    res.json({
      data,
      access: { authenticated: true, configured: true, canSetup: false },
    });
  }
  function permittedOrigin(req: Request): boolean {
    const origin = req.get('origin');
    if (!origin || req.get('sec-fetch-site') === 'cross-site') return false;
    try {
      const url = new URL(origin);
      if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) return false;
      if (production && url.protocol !== 'https:') return false;
      if (url.host === req.get('host')) return true;
      // Vite proxies /api to the local Node server during development.
      return (
        !production &&
        isLoopback(req.socket.remoteAddress) &&
        localHost(url.host) &&
        localHost(req.get('host') ?? '')
      );
    } catch {
      return false;
    }
  }

  router.use(async (_req, res, next) => {
    await storageReady;
    res.set('Cache-Control', 'no-store');
    res.set('Vary', 'Cookie');
    res.set('X-Content-Type-Options', 'nosniff');
    if (unavailable) return void res.status(503).json({ error: unavailable });
    next();
  });
  router.use((req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !permittedOrigin(req)) {
      return void res.status(403).json({ error: 'Rankings changes must come from this website.' });
    }
    next();
  });
  router.use((req, res, next) => {
    if (req.method === 'PUT' && !authenticated(req)) {
      return void res.status(401).json({ error: 'Sign in as the owner to edit rankings.' });
    }
    next();
  });
  const ledgerJson = express.json({ limit: '16mb', strict: true });
  const authJson = express.json({ limit: '4kb', strict: true });
  router.use((req, res, next) => (req.method === 'PUT' ? ledgerJson : authJson)(req, res, next));
  router.get('/', async (req, res) => {
    try {
      res.json(await payload(req));
    } catch (error) {
      storageFailure(res, error);
    }
  });
  router.post('/setup', async (req, res) => {
    if (!canSetup(req)) {
      return void res.status(403).json({
        error: credentials
          ? 'An owner password is already configured. Sign in to edit rankings.'
          : 'First-time owner setup is available only on this computer in development. Configure RANKINGS_ADMIN_PASSWORD on a hosted server.',
      });
    }
    let secret: string;
    try {
      secret = password(req.body?.password);
    } catch (error) {
      return void res.status(400).json({ error: (error as Error).message });
    }
    try {
      const next = makeCredentials(secret);
      atomicJson(credentialsFile, next);
      credentials = next;
      await issueSession(req, res);
    } catch {
      res.status(503).json({
        error: 'Could not save the owner password. Check the server data directory permissions.',
      });
    }
  });
  router.post('/login', async (req, res) => {
    if (!credentials)
      return void res.status(409).json({ error: 'An owner password has not been configured yet.' });
    const now = Date.now();
    for (const [key, value] of attempts) if (value.reset <= now) attempts.delete(key);
    const address = req.socket.remoteAddress ?? 'unknown';
    const limit = attempts.get(address) ?? { count: 0, reset: now + 15 * 60 * 1_000 };
    if (limit.count >= 10 || pendingLogins >= 8) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((limit.reset - now) / 1_000))));
      return void res
        .status(429)
        .json({ error: 'Too many sign-in attempts. Wait a few minutes before trying again.' });
    }
    limit.count++;
    attempts.set(address, limit);
    let secret: string;
    try {
      secret = password(req.body?.password);
    } catch {
      return void res.status(401).json({ error: 'The owner password is incorrect.' });
    }
    pendingLogins++;
    try {
      if (!(await matches(secret, credentials))) {
        return void res.status(401).json({ error: 'The owner password is incorrect.' });
      }
      attempts.delete(address);
      await issueSession(req, res);
    } catch {
      res
        .status(503)
        .json({ error: 'Owner sign-in is temporarily unavailable. Please try again.' });
    } finally {
      pendingLogins--;
    }
  });
  router.post('/logout', async (req, res) => {
    const key = sessionKey(req);
    if (key) sessions.delete(key);
    res.clearCookie(COOKIE, {
      httpOnly: true,
      secure: production,
      sameSite: 'strict',
      path: '/api/rankings',
    });
    try {
      res.json(await payload(req));
    } catch (error) {
      storageFailure(res, error);
    }
  });
  router.put('/', async (req, res) => {
    if (!authenticated(req))
      return void res.status(401).json({ error: 'Sign in as the owner to edit rankings.' });
    let next: RankingsData;
    try {
      next = validateRankings(req.body);
    } catch (error) {
      return void res.status(400).json({ error: (error as Error).message });
    }
    try {
      const data = await store.save(next);
      res.json({
        data,
        access: {
          authenticated: authenticated(req),
          configured: !!credentials,
          canSetup: canSetup(req),
        },
      });
    } catch (error) {
      if (error instanceof RankingsConflictError)
        return void res.status(409).json({ error: error.message });
      storageFailure(res, error);
    }
  });
  router.use((error: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    const status = (error as { status?: number })?.status;
    res.status(status === 413 ? 413 : 400).json({
      error:
        status === 413
          ? 'The rankings request is too large.'
          : 'Send a valid JSON rankings request.',
    });
  });
  return router;
}
