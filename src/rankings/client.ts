import type { RankingsData } from './model';
import type { RankingsAccess } from './types';
export { RankingsError } from './types';
export type { RankingsAccess, RankingsReply } from './types';

// Public reads use Firebase by default; owner actions always use server authentication.
export const usesFirebaseRankings = import.meta.env.VITE_RANKINGS_TRANSPORT !== 'http';
const client = () => (usesFirebaseRankings ? import('./firebase-client') : import('./http-client'));

export const loadRankings = async () => (await client()).loadRankings();
export const saveRankings = async (data: RankingsData) => (await client()).saveRankings(data);
export const loginRankings = async (identity: string, password: string) =>
  (await client()).loginRankings(identity, password);
export const logoutRankings = async () => (await client()).logoutRankings();

export function watchRankingsAccess(listener: (access: RankingsAccess) => void): () => void {
  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  if (usesFirebaseRankings) {
    void import('./firebase-client')
      .then((firebase) => {
        if (!disposed) unsubscribe = firebase.watchRankingsAccess(listener);
      })
      .catch(() => {
        /* loadRankings reports configuration and network errors. */
      });
  }
  return () => {
    disposed = true;
    unsubscribe?.();
  };
}
