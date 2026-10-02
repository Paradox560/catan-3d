import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import {
  collection,
  doc,
  getDocFromServer,
  getDocsFromServer,
  limit,
  query,
  runTransaction,
  type DocumentReference,
  type DocumentSnapshot,
  type QuerySnapshot,
} from 'firebase/firestore';
import { getFirebaseServices, type FirebaseServices } from '../firebase';
import { RankingsError, type RankingsAccess, type RankingsReply } from './types';
import {
  emptyRankings,
  validateRankings,
  type RankedPlayer,
  type RankingsData,
  type RecordedGame,
} from './model';

const LEDGER = 'catan/rankings';
const SCHEMA = 'catan-rankings-v1';
const MAX_WRITES = 450;
const MAX_WRITE_BYTES = 8 * 1024 * 1024;
const CORRUPT =
  'The saved rankings are invalid or incomplete. No records were changed. Restore the ledger from a backup before saving.';
const CONFLICT =
  'The rankings changed since you opened them. Review the latest records before saving again.';
const SIGN_IN = 'The email or password is incorrect, or this account cannot edit rankings.';

type RankingRecord = RankedPlayer | RecordedGame;
interface LedgerSnapshot {
  data: RankingsData;
  metadata: string | null;
  records: Map<string, unknown>;
}
type RecordWrite =
  | { kind: 'set'; ref: DocumentReference; data: RankingRecord; previous?: unknown }
  | { kind: 'delete'; ref: DocumentReference; previous: unknown };
const denied = (error: unknown) =>
  !!error && typeof error === 'object' && 'code' in error && error.code === 'permission-denied';
function safeFailure(error: unknown, operation: 'read' | 'save' | 'login' | 'logout'): never {
  if (error instanceof RankingsError) throw error;
  const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
  if (operation === 'login') {
    if (code === 'auth/network-request-failed')
      throw new RankingsError('Could not reach Firebase. Check your connection and try again.', 0);
    if (code === 'auth/too-many-requests')
      throw new RankingsError('Too many sign-in attempts. Wait a moment and try again.', 429);
    throw new RankingsError(SIGN_IN, 401);
  }
  if (denied(error))
    throw new RankingsError(
      operation === 'save'
        ? 'Owner access is required to save rankings. Sign in again and retry.'
        : 'The rankings could not be accessed. Check the Firestore Rules and try again.',
      operation === 'save' ? 401 : 403,
    );
  if (code === 'aborted') throw new RankingsError(CONFLICT, 409);
  throw new RankingsError(
    operation === 'save'
      ? 'Could not confirm that your changes were saved. Refresh the rankings before trying again.'
      : operation === 'logout'
        ? 'Could not finish signing out. Please try again.'
        : 'Could not load the shared rankings. Check your connection and Firebase configuration, then retry.',
    0,
  );
}

function fingerprint(snapshot: DocumentSnapshot): string | null {
  return snapshot.exists() ? JSON.stringify(snapshot.data()) : null;
}
function records(
  snapshot: QuerySnapshot,
  prefix: string,
  output: Map<string, unknown>,
): Map<string, unknown> {
  return new Map(
    snapshot.docs.map((record) => {
      const data = record.data();
      if (data.id !== record.id) throw new RankingsError(CORRUPT, 502);
      output.set(`${prefix}/${record.id}`, data);
      return [record.id, data];
    }),
  );
}
function ordered(ids: unknown, source: Map<string, unknown>, maximum: number): unknown[] {
  if (
    !Array.isArray(ids) ||
    ids.length > maximum ||
    ids.length !== source.size ||
    ids.some((id) => typeof id !== 'string' || !source.has(id)) ||
    new Set(ids).size !== ids.length
  )
    throw new RankingsError(CORRUPT, 502);
  return ids.map((id) => source.get(id));
}
function validatedSnapshot(
  metadata: DocumentSnapshot,
  players: QuerySnapshot,
  games: QuerySnapshot,
): LedgerSnapshot {
  const existing = new Map<string, unknown>();
  const playerRecords = records(players, 'players', existing);
  const gameRecords = records(games, 'games', existing);
  if (!metadata.exists()) {
    if (existing.size) throw new RankingsError(CORRUPT, 502);
    return { data: emptyRankings(), metadata: null, records: existing };
  }
  const fields = metadata.data();
  if (fields.schema !== SCHEMA) throw new RankingsError(CORRUPT, 502);
  try {
    return {
      data: validateRankings({
        version: fields.version,
        revision: fields.revision,
        players: ordered(fields.playerIds, playerRecords, 500),
        games: ordered(fields.gameIds, gameRecords, 2000),
      }),
      metadata: fingerprint(metadata),
      records: existing,
    };
  } catch {
    throw new RankingsError(CORRUPT, 502);
  }
}

/** Injectable SDK services let the same browser path run against isolated test emulators. */
export function createFirebaseRankingsClient(services: FirebaseServices) {
  const { db, auth } = services;
  const ledger = doc(db, LEDGER);
  const gate = doc(db, `${LEDGER}/access/owner`);
  const ready = async () => {
    await services.ready;
    await auth.authStateReady();
  };
  const access = (authenticated: boolean): RankingsAccess => ({
    authenticated,
    configured: true,
    canSetup: false,
  });

  async function readAccess(): Promise<RankingsAccess> {
    await ready();
    const uid = auth.currentUser?.uid;
    if (!uid) return access(false);
    try {
      // Rules allow only the owner's UID to get this path. It need not contain a document.
      await getDocFromServer(gate);
      return access(auth.currentUser?.uid === uid);
    } catch (error) {
      if (denied(error)) return access(false);
      return safeFailure(error, 'read');
    }
  }

  async function snapshot(): Promise<LedgerSnapshot> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = await getDocFromServer(ledger);
      const [players, games] = await Promise.all([
        getDocsFromServer(query(collection(ledger, 'players'), limit(501))),
        getDocsFromServer(query(collection(ledger, 'games'), limit(2001))),
      ]);
      const after = await getDocFromServer(ledger);
      // Each writer atomically increments metadata with every child change. Never
      // combine queries from separate revisions or fall back to cached/offline data.
      if (fingerprint(before) !== fingerprint(after)) continue;
      return validatedSnapshot(after, players, games);
    }
    throw new RankingsError(CONFLICT, 409);
  }

  async function loadRankings(): Promise<RankingsReply> {
    try {
      await ready();
      const [current, permission] = await Promise.all([snapshot(), readAccess()]);
      return { data: current.data, access: permission };
    } catch (error) {
      return safeFailure(error, 'read');
    }
  }

  async function loginRankings(email: string, password: string): Promise<RankingsReply> {
    try {
      await ready();
      if (!email.trim() || email.length > 320 || !password || password.length > 4096)
        throw new RankingsError(SIGN_IN, 401);
      await signInWithEmailAndPassword(auth, email.trim(), password);
      if (!(await readAccess()).authenticated) {
        await signOut(auth);
        throw new RankingsError(SIGN_IN, 401);
      }
    } catch (error) {
      return safeFailure(error, 'login');
    }
    return loadRankings();
  }

  async function logoutRankings(): Promise<RankingsReply> {
    try {
      await ready();
      await signOut(auth);
    } catch (error) {
      return safeFailure(error, 'logout');
    }
    return loadRankings();
  }

  async function saveRankings(input: RankingsData): Promise<RankingsReply> {
    let next: RankingsData;
    try {
      next = validateRankings(input);
    } catch {
      throw new RankingsError('The supplied rankings are invalid. No records were changed.', 400);
    }
    try {
      if (!(await readAccess()).authenticated)
        throw new RankingsError(
          'Owner access is required to save rankings. Sign in again and retry.',
          401,
        );
      const uid = auth.currentUser?.uid;
      const current = await snapshot();
      if (current.data.revision !== next.revision) throw new RankingsError(CONFLICT, 409);
      if (next.revision === Number.MAX_SAFE_INTEGER)
        throw new RankingsError(
          'The rankings revision limit has been reached. No records were changed.',
          400,
        );
      const saved: RankingsData = { ...next, revision: next.revision + 1 };
      const metadata = {
        schema: SCHEMA,
        version: saved.version,
        revision: saved.revision,
        playerIds: saved.players.map((player) => player.id),
        gameIds: saved.games.map((game) => game.id),
      };
      const writes: RecordWrite[] = [];
      function collect(name: string, before: RankingRecord[], after: RankingRecord[]) {
        const previous = new Map(before.map((record) => [record.id, record]));
        for (const record of after) {
          const old = previous.get(record.id);
          previous.delete(record.id);
          if (JSON.stringify(old) !== JSON.stringify(record)) {
            writes.push({
              kind: 'set',
              ref: doc(ledger, name, record.id),
              data: record,
              previous: current.records.get(`${name}/${record.id}`),
            });
          }
        }
        for (const record of previous.values()) {
          writes.push({
            kind: 'delete',
            ref: doc(ledger, name, record.id),
            previous: current.records.get(`${name}/${record.id}`),
          });
        }
      }
      collect('players', current.data.players, saved.players);
      collect('games', current.data.games, saved.games);
      if (writes.length + 1 > MAX_WRITES)
        throw new RankingsError(
          'This update changes too many records at once. Save at most 449 changed players or games per update.',
          400,
        );
      const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
      const estimatedBytes =
        1024 +
        bytes(metadata) * 2 +
        writes.reduce(
          (total, write) =>
            total +
            1024 +
            bytes(write.ref.path) * 2 +
            bytes(write.previous ?? null) * 2 +
            (write.kind === 'set' ? bytes(write.data) * 2 : 0),
          0,
        );
      if (estimatedBytes > MAX_WRITE_BYTES)
        throw new RankingsError(
          'This update is too large for one Firestore transaction. Save fewer changes at a time.',
          400,
        );

      try {
        await runTransaction(db, async (transaction) => {
          const latest = await transaction.get(ledger);
          if (fingerprint(latest) !== current.metadata) throw new RankingsError(CONFLICT, 409);
          const documents = await Promise.all(writes.map((write) => transaction.get(write.ref)));
          for (const [index, write] of writes.entries()) {
            const actual = documents[index];
            if (
              JSON.stringify(actual.exists() ? actual.data() : undefined) !==
              JSON.stringify(write.previous)
            )
              throw new RankingsError(CONFLICT, 409);
          }
          if (!uid || auth.currentUser?.uid !== uid)
            throw new RankingsError(
              'Owner access is required to save rankings. Sign in again and retry.',
              401,
            );
          // Rules enforce the owner UID, revision increment, and index membership on
          // this atomic commit. No unindexed or private documents are ever deleted.
          for (const write of writes) {
            if (write.kind === 'set') transaction.set(write.ref, write.data);
            else transaction.delete(write.ref);
          }
          transaction.set(ledger, metadata);
        });
      } catch (error) {
        // Rules may reject a stale revision before the SDK reports an aborted
        // transaction. Confirm both continued owner access and changed metadata
        // before presenting that rejection as a conflict instead of a sign-in error.
        if (denied(error) && auth.currentUser?.uid === uid) {
          let conflict = false;
          try {
            const [permission, latest] = await Promise.all([
              readAccess(),
              getDocFromServer(ledger),
            ]);
            conflict =
              permission.authenticated &&
              auth.currentUser?.uid === uid &&
              fingerprint(latest) !== current.metadata;
          } catch {
            // If verification fails, preserve the original access-denied result.
          }
          if (conflict) throw new RankingsError(CONFLICT, 409);
        }
        throw error;
      }
      return { data: saved, access: access(auth.currentUser?.uid === uid) };
    } catch (error) {
      return safeFailure(error, 'save');
    }
  }

  function watchRankingsAccess(listener: (value: RankingsAccess) => void): () => void {
    let active = true;
    let generation = 0;
    const unsubscribe = onAuthStateChanged(auth, () => {
      const current = ++generation;
      void readAccess().then(
        (permission) => {
          if (active && generation === current) listener(permission);
        },
        () => {
          if (active && generation === current) listener(access(false));
        },
      );
    });
    return () => {
      active = false;
      generation += 1;
      unsubscribe();
    };
  }

  return {
    loadRankings,
    saveRankings,
    loginRankings,
    logoutRankings,
    readAccess,
    watchRankingsAccess,
  };
}

let client: ReturnType<typeof createFirebaseRankingsClient> | undefined;
function getClient() {
  try {
    return (client ??= createFirebaseRankingsClient(getFirebaseServices()));
  } catch {
    throw new RankingsError(
      'Set the Firebase web app configuration in Vercel and redeploy to connect the shared rankings.',
      503,
    );
  }
}
export const loadRankings = async () => getClient().loadRankings();
export const saveRankings = async (data: RankingsData) => getClient().saveRankings(data);
export const loginRankings = async (email: string, password: string) =>
  getClient().loginRankings(email, password);
export const logoutRankings = async () => getClient().logoutRankings();
export const watchRankingsAccess = (listener: (value: RankingsAccess) => void) => {
  try {
    return getClient().watchRankingsAccess(listener);
  } catch {
    listener({ authenticated: false, configured: false, canSetup: false });
    return () => {};
  }
};
