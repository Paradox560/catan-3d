import {
  collection,
  doc,
  getDocFromServer,
  getDocsFromServer,
  limit,
  query,
  type DocumentSnapshot,
  type QuerySnapshot,
} from 'firebase/firestore';
import { getFirebaseServices, type FirebaseServices } from '../firebase';
import * as http from './http-client';
import { RankingsError, type RankingsAccess, type RankingsReply } from './types';
import { emptyRankings, validateRankings, type RankingsData } from './model';

const LEDGER = 'catan/rankings';
const SCHEMA = 'catan-rankings-v1';
const CORRUPT =
  'The saved rankings are invalid or incomplete. No records were changed. Restore the ledger from a backup before saving.';
const CONFLICT =
  'The rankings changed since you opened them. Review the latest records before saving again.';
export type RankingsOwnerClient = Pick<
  typeof http,
  'loadRankingsAccess' | 'loginRankings' | 'logoutRankings' | 'saveRankings'
>;

function readFailure(error: unknown): never {
  if (error instanceof RankingsError) throw error;
  const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
  if (code === 'permission-denied')
    throw new RankingsError(
      'The rankings could not be accessed. Check the Firestore Rules and try again.',
      403,
    );
  throw new RankingsError(
    'Could not load the shared rankings. Check your connection and Firebase configuration, then retry.',
    0,
  );
}
function fingerprint(snapshot: DocumentSnapshot): string | null {
  return snapshot.exists() ? JSON.stringify(snapshot.data()) : null;
}
function records(snapshot: QuerySnapshot): Map<string, unknown> {
  return new Map(
    snapshot.docs.map((record) => {
      const data = record.data();
      if (data.id !== record.id) throw new RankingsError(CORRUPT, 502);
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
): RankingsData {
  const playerRecords = records(players);
  const gameRecords = records(games);
  if (!metadata.exists()) {
    if (playerRecords.size || gameRecords.size) throw new RankingsError(CORRUPT, 502);
    return emptyRankings();
  }
  const fields = metadata.data();
  if (fields.schema !== SCHEMA) throw new RankingsError(CORRUPT, 502);
  try {
    return validateRankings({
      version: fields.version,
      revision: fields.revision,
      players: ordered(fields.playerIds, playerRecords, 500),
      games: ordered(fields.gameIds, gameRecords, 2000),
    });
  } catch {
    throw new RankingsError(CORRUPT, 502);
  }
}

/** Public SDK reads, with all owner authentication and writes delegated to the server. */
export function createFirebaseRankingsClient(
  services: FirebaseServices,
  owner: RankingsOwnerClient = http,
) {
  const ledger = doc(services.db, LEDGER);
  const listeners = new Set<(value: RankingsAccess) => void>();
  let permission: RankingsAccess = { authenticated: false, configured: false, canSetup: false };
  let generation = 0;
  let pending: Promise<RankingsAccess> | undefined;
  function publish(value: RankingsAccess) {
    permission = value;
    for (const listener of listeners) listener(value);
  }

  function readAccess(): Promise<RankingsAccess> {
    if (pending) return pending;
    const started = generation;
    const request = owner
      .loadRankingsAccess()
      .catch(() => ({
        authenticated: false,
        configured: false,
        canSetup: false,
      }))
      .then((value) => {
        if (started === generation) publish(value);
        return permission;
      })
      .finally(() => {
        if (pending === request) pending = undefined;
      });
    pending = request;
    return request;
  }

  async function snapshot(): Promise<RankingsData> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = await getDocFromServer(ledger);
      const [players, games] = await Promise.all([
        getDocsFromServer(query(collection(ledger, 'players'), limit(501))),
        getDocsFromServer(query(collection(ledger, 'games'), limit(2001))),
      ]);
      const after = await getDocFromServer(ledger);
      // Server saves atomically advance metadata with every child change. Never
      // mix revisions or replace a failed server read with cached/offline data.
      if (fingerprint(before) !== fingerprint(after)) continue;
      return validatedSnapshot(after, players, games);
    }
    throw new RankingsError(CONFLICT, 409);
  }
  async function loadRankings(): Promise<RankingsReply> {
    try {
      const [data] = await Promise.all([snapshot(), readAccess()]);
      return { data, access: permission };
    } catch (error) {
      return readFailure(error);
    }
  }
  async function ownerAction(action: () => Promise<RankingsReply>): Promise<RankingsReply> {
    const started = ++generation;
    pending = undefined;
    try {
      const reply = await action();
      if (started === generation) {
        generation += 1;
        pending = undefined;
        publish(reply.access);
      }
      return reply;
    } catch (error) {
      if (started === generation && error instanceof RankingsError && error.status === 401) {
        generation += 1;
        pending = undefined;
        publish({ ...permission, authenticated: false });
      }
      throw error;
    }
  }
  const loginRankings = (username: string, password: string) =>
    ownerAction(() => owner.loginRankings(username, password));
  const logoutRankings = () => ownerAction(() => owner.logoutRankings());
  const saveRankings = (input: RankingsData) => {
    let data: RankingsData;
    try {
      data = validateRankings(input);
    } catch {
      return Promise.reject(
        new RankingsError('The supplied rankings are invalid. No records were changed.', 400),
      );
    }
    return ownerAction(() => owner.saveRankings(data));
  };
  function watchRankingsAccess(listener: (value: RankingsAccess) => void): () => void {
    listeners.add(listener);
    const refresh = () => {
      void readAccess();
    };
    refresh();
    if (typeof window !== 'undefined') window.addEventListener('focus', refresh);
    return () => {
      listeners.delete(listener);
      if (typeof window !== 'undefined') window.removeEventListener('focus', refresh);
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
export const loginRankings = async (username: string, password: string) =>
  getClient().loginRankings(username, password);
export const logoutRankings = async () => getClient().logoutRankings();
export const watchRankingsAccess = (listener: (value: RankingsAccess) => void) => {
  try {
    return getClient().watchRankingsAccess(listener);
  } catch {
    listener({ authenticated: false, configured: false, canSetup: false });
    return () => {};
  }
};
