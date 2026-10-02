import { createHash, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';

export const OWNER_SESSION_LIFETIME = 12 * 60 * 60 * 1_000;
export const OWNER_LOGIN_WINDOW = 15 * 60 * 1_000;
export const OWNER_LOGIN_LIMIT = 10;
export const hashOwnerToken = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

export interface OwnerCredentials {
  usernameHash: Buffer;
  passwordHash: Buffer;
  salt: string;
  fingerprint: string;
}
export interface OwnerSession {
  expires: number;
  fingerprint: string;
}
export interface LoginReservation {
  allowed: boolean;
  reset: number;
}
export interface OwnerAuthStore {
  readSession(key: string): Promise<OwnerSession | null>;
  issueSession(key: string, session: OwnerSession, previous: string | null): Promise<void>;
  revokeSession(key: string): Promise<void>;
  reserveLogin(key: string, now: number): Promise<LoginReservation>;
  clearLogins(key: string): Promise<void>;
}

export type OwnerConfigurationIssue =
  | 'username-missing'
  | 'username-surrounding-whitespace'
  | 'username-too-long'
  | 'username-invalid-characters'
  | 'password-missing'
  | 'password-too-short'
  | 'password-too-long';

/** A fixed diagnostic code only: never include credential values, lengths, or hashes. */
export function ownerConfigurationIssue(
  env: NodeJS.ProcessEnv = process.env,
): OwnerConfigurationIssue | null {
  const username = env.RANKINGS_ADMIN_USERNAME;
  const password = env.RANKINGS_ADMIN_PASSWORD;
  if (!username) return 'username-missing';
  if (username !== username.trim()) return 'username-surrounding-whitespace';
  if (username.length > 128) return 'username-too-long';
  if (/[\u0000-\u001f\u007f]/.test(username)) return 'username-invalid-characters';
  if (!password) return 'password-missing';
  if (password.length < 10) return 'password-too-short';
  if (Buffer.byteLength(password, 'utf8') > 1_024) return 'password-too-long';
  return null;
}

/** Environment credentials are the only owner identity; missing/invalid values disable editing. */
export function ownerCredentials(env: NodeJS.ProcessEnv = process.env): OwnerCredentials | null {
  if (ownerConfigurationIssue(env) !== null) return null;
  const username = env.RANKINGS_ADMIN_USERNAME!;
  const password = env.RANKINGS_ADMIN_PASSWORD!;
  const usernameHash = createHash('sha256').update(username).digest();
  // A stable, username-specific salt makes credentials portable across serverless instances.
  // The fingerprint is derived from the slow password hash, never from plaintext credentials.
  const salt = hashOwnerToken(`catan-owner-v1:${username}`);
  const passwordHash = scryptSync(password, salt, 64);
  return {
    usernameHash,
    passwordHash,
    salt,
    fingerprint: createHash('sha256').update(usernameHash).update(passwordHash).digest('hex'),
  };
}

export async function matchesOwner(
  username: unknown,
  password: unknown,
  credentials: OwnerCredentials,
): Promise<boolean> {
  const validUsername = typeof username === 'string' && username.length <= 128;
  const validPassword =
    typeof password === 'string' && Buffer.byteLength(password, 'utf8') <= 1_024;
  const usernameHash = createHash('sha256')
    .update(validUsername ? username : '')
    .digest();
  // Derive even for a wrong username or malformed input, so neither reveals the configured name.
  const derived = await new Promise<Buffer>((resolve, reject) => {
    scrypt(validPassword ? password : '', credentials.salt, 64, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
  const usernameMatches = timingSafeEqual(usernameHash, credentials.usernameHash);
  const passwordMatches = timingSafeEqual(derived, credentials.passwordHash);
  return validUsername && validPassword && usernameMatches && passwordMatches;
}

/** Development file storage has one long-lived Node process. Hosted Firestore uses a shared store. */
export class MemoryOwnerAuthStore implements OwnerAuthStore {
  private readonly sessions = new Map<string, OwnerSession>();
  private readonly attempts = new Map<string, { count: number; reset: number }>();

  async readSession(key: string): Promise<OwnerSession | null> {
    const session = this.sessions.get(key);
    if (!session || session.expires <= Date.now()) {
      this.sessions.delete(key);
      return null;
    }
    return session;
  }
  async issueSession(key: string, session: OwnerSession, previous: string | null): Promise<void> {
    if (previous) this.sessions.delete(previous);
    for (const [id, value] of this.sessions)
      if (value.expires <= Date.now()) this.sessions.delete(id);
    while (this.sessions.size >= 64) this.sessions.delete(this.sessions.keys().next().value!);
    this.sessions.set(key, session);
  }
  async revokeSession(key: string): Promise<void> {
    this.sessions.delete(key);
  }
  async reserveLogin(key: string, now: number): Promise<LoginReservation> {
    for (const [id, value] of this.attempts) if (value.reset <= now) this.attempts.delete(id);
    const value = this.attempts.get(key) ?? { count: 0, reset: now + OWNER_LOGIN_WINDOW };
    if (value.count >= OWNER_LOGIN_LIMIT) return { allowed: false, reset: value.reset };
    value.count++;
    this.attempts.set(key, value);
    return { allowed: true, reset: value.reset };
  }
  async clearLogins(key: string): Promise<void> {
    this.attempts.delete(key);
  }
}
