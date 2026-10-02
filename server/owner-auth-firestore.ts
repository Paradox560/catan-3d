import { Timestamp, type DocumentReference, type Firestore } from 'firebase-admin/firestore';
import {
  OWNER_LOGIN_LIMIT,
  OWNER_LOGIN_WINDOW,
  type LoginReservation,
  type OwnerAuthStore,
  type OwnerSession,
} from './owner-auth.js';

/** Private server-only collections: raw cookies, usernames, and passwords are never written. */
export class FirestoreOwnerAuthStore implements OwnerAuthStore {
  private readonly ledger: DocumentReference;
  constructor(
    private readonly firestore: Firestore,
    documentPath: string,
  ) {
    this.ledger = firestore.doc(documentPath);
  }

  async readSession(key: string): Promise<OwnerSession | null> {
    const value = (await this.ledger.collection('ownerSessions').doc(key).get()).data();
    if (
      value?.version !== 1 ||
      !(value.expiresAt instanceof Timestamp) ||
      typeof value.fingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.fingerprint)
    )
      return null;
    const expires = value.expiresAt.toMillis();
    return expires > Date.now() ? { expires, fingerprint: value.fingerprint } : null;
  }

  async issueSession(key: string, session: OwnerSession, previous: string | null): Promise<void> {
    const batch = this.firestore.batch();
    if (previous) batch.delete(this.ledger.collection('ownerSessions').doc(previous));
    batch.set(this.ledger.collection('ownerSessions').doc(key), {
      version: 1,
      fingerprint: session.fingerprint,
      expiresAt: Timestamp.fromMillis(session.expires),
    });
    await batch.commit();
  }
  async revokeSession(key: string): Promise<void> {
    await this.ledger.collection('ownerSessions').doc(key).delete();
  }
  async reserveLogin(key: string, now: number): Promise<LoginReservation> {
    const reference = this.ledger.collection('ownerRateLimits').doc(key);
    return this.firestore.runTransaction(async (transaction) => {
      const value = (await transaction.get(reference)).data();
      const active = value?.expiresAt instanceof Timestamp && value.expiresAt.toMillis() > now;
      // Malformed active state fails closed instead of resetting an existing security limit.
      if (active && (!Number.isSafeInteger(value.count) || value.count < 0)) {
        return { allowed: false, reset: value.expiresAt.toMillis() };
      }
      const count = active ? value.count : 0;
      const reset = active ? value.expiresAt.toMillis() : now + OWNER_LOGIN_WINDOW;
      if (count >= OWNER_LOGIN_LIMIT) return { allowed: false, reset };
      transaction.set(reference, {
        version: 1,
        count: count + 1,
        expiresAt: Timestamp.fromMillis(reset),
      });
      return { allowed: true, reset };
    });
  }
  async clearLogins(key: string): Promise<void> {
    await this.ledger.collection('ownerRateLimits').doc(key).delete();
  }
}
