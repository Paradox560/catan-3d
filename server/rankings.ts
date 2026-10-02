import express, { type Request, type Response } from 'express';
import { randomBytes } from 'node:crypto';
import { validateRankings, type RankingsData } from '../src/rankings/model';
import { createRankingsServices } from './rankings-storage';
import { RankingsConflictError, RankingsStorageError, type RankingsStore } from './rankings-store';
import {
  hashOwnerToken,
  matchesOwner,
  ownerCredentials,
  OWNER_SESSION_LIFETIME,
  type OwnerAuthStore,
} from './owner-auth';

const COOKIE = 'catan_rankings_owner';
const isLoopback = (address: string | undefined): boolean =>
  address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
const localHost = (host: string): boolean => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);

/** Public rankings and environment-configured owner editing. */
export function rankingsRouter(dataDir: string): express.Router {
  const router = express.Router();
  const production = process.env.NODE_ENV === 'production';
  const credentials = ownerCredentials();
  const distributed = process.env.RANKINGS_STORAGE === 'firestore';
  let store: RankingsStore;
  let ownerAuth: OwnerAuthStore;
  let unavailable: string | null = null;
  let pendingLogins = 0;

  const storageReady = createRankingsServices(dataDir)
    .then((value) => {
      store = value.store;
      ownerAuth = value.ownerAuth;
    })
    .catch((error: unknown) => {
      unavailable =
        error instanceof RankingsStorageError
          ? error.message
          : 'Rankings storage could not be initialized. Check the server configuration.';
      console.error('Rankings storage is unavailable. Check its server configuration.');
    });

  function storageFailure(res: Response, error: unknown): void {
    res.status(503).json({
      error:
        error instanceof RankingsStorageError
          ? error.message
          : 'The rankings store is unavailable. Check its connection and credentials, then retry. No local fallback has been used.',
    });
  }
  function sessionKey(req: Request): string | null {
    const value = req.headers.cookie
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1);
    return value && /^[a-f0-9]{64}$/.test(value) ? hashOwnerToken(value) : null;
  }
  async function authenticated(req: Request): Promise<boolean> {
    if (!credentials) return false;
    const key = sessionKey(req);
    if (!key) return false;
    const session = await ownerAuth.readSession(key);
    return (
      !!session && session.expires > Date.now() && session.fingerprint === credentials.fingerprint
    );
  }
  async function payload(req: Request) {
    const [data, signedIn] = await Promise.all([store.read(), authenticated(req)]);
    return {
      data,
      access: { authenticated: signedIn, configured: !!credentials, canSetup: false },
    };
  }
  async function issueSession(req: Request, res: Response): Promise<void> {
    const data = await store.read();
    const token = randomBytes(32).toString('hex');
    await ownerAuth.issueSession(
      hashOwnerToken(token),
      { expires: Date.now() + OWNER_SESSION_LIFETIME, fingerprint: credentials!.fingerprint },
      sessionKey(req),
    );
    res.cookie(COOKIE, token, {
      httpOnly: true,
      secure: production,
      sameSite: 'strict',
      path: '/api/rankings',
      maxAge: OWNER_SESSION_LIFETIME,
    });
    res.json({ data, access: { authenticated: true, configured: true, canSetup: false } });
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

  // This retired endpoint cannot create credentials, even when storage is unconfigured.
  router.post('/setup', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res
      .status(403)
      .json({ error: 'Owner access is configured through server environment variables.' });
  });
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
  router.use(async (req, res, next) => {
    if (req.method !== 'PUT') return next();
    try {
      if (!(await authenticated(req))) {
        return void res.status(401).json({ error: 'Sign in as the owner to edit rankings.' });
      }
      next();
    } catch {
      res
        .status(503)
        .json({ error: 'Owner authentication is temporarily unavailable. Please try again.' });
    }
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
  router.post('/login', async (req, res) => {
    if (!credentials) {
      return void res
        .status(409)
        .json({ error: 'Owner sign-in is not configured on this server.' });
    }
    // One account-wide limit in Firestore prevents address spoofing and instance hopping.
    const address = distributed ? 'owner' : (req.socket.remoteAddress ?? 'unknown');
    const limitKey = hashOwnerToken(`${credentials.fingerprint}:${address}`);
    if (pendingLogins >= 8) {
      res.set('Retry-After', '60');
      return void res
        .status(429)
        .json({ error: 'Too many sign-in attempts. Wait a few minutes before trying again.' });
    }
    pendingLogins++;
    try {
      const now = Date.now();
      const limit = await ownerAuth.reserveLogin(limitKey, now);
      if (!limit.allowed) {
        res.set('Retry-After', String(Math.max(1, Math.ceil((limit.reset - now) / 1_000))));
        return void res
          .status(429)
          .json({ error: 'Too many sign-in attempts. Wait a few minutes before trying again.' });
      }
      if (!(await matchesOwner(req.body?.username, req.body?.password, credentials))) {
        return void res.status(401).json({ error: 'The owner username or password is incorrect.' });
      }
      await ownerAuth.clearLogins(limitKey);
      await issueSession(req, res);
    } catch {
      if (!res.headersSent)
        res
          .status(503)
          .json({ error: 'Owner sign-in is temporarily unavailable. Please try again.' });
    } finally {
      pendingLogins--;
    }
  });
  router.post('/logout', async (req, res) => {
    try {
      const key = sessionKey(req);
      if (key) await ownerAuth.revokeSession(key);
      res.clearCookie(COOKIE, {
        httpOnly: true,
        secure: production,
        sameSite: 'strict',
        path: '/api/rankings',
      });
      res.json(await payload(req));
    } catch {
      res.status(503).json({ error: 'Owner sign-out could not be confirmed. Please try again.' });
    }
  });
  router.put('/', async (req, res) => {
    let next: RankingsData;
    try {
      next = validateRankings(req.body);
    } catch (error) {
      return void res.status(400).json({ error: (error as Error).message });
    }
    try {
      const data = await store.save(next);
      res.json({ data, access: { authenticated: true, configured: true, canSetup: false } });
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
