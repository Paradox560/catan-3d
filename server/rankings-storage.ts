import { FileRankingsStore, RankingsStorageError, type RankingsStore } from './rankings-store.js';
import { MemoryOwnerAuthStore, type OwnerAuthStore } from './owner-auth.js';

export async function createRankingsStore(directory: string): Promise<RankingsStore> {
  return (await createRankingsServices(directory)).store;
}

export async function createRankingsServices(directory: string): Promise<{
  store: RankingsStore;
  ownerAuth: OwnerAuthStore;
}> {
  const storage =
    process.env.RANKINGS_STORAGE ?? (process.env.VERCEL === '1' ? 'firestore' : 'file');
  if (process.env.VERCEL === '1' && storage === 'file') {
    throw new RankingsStorageError(
      'Vercel requires Firestore storage. Remove RANKINGS_STORAGE=file and redeploy.',
    );
  }
  if (storage === 'file')
    return { store: new FileRankingsStore(directory), ownerAuth: new MemoryOwnerAuthStore() };
  if (storage !== 'firestore') {
    throw new RankingsStorageError(
      'RANKINGS_STORAGE must be file or firestore. No records have been changed.',
    );
  }
  try {
    const [{ createRankingsFirestore }, { FirestoreRankingsStore }, { FirestoreOwnerAuthStore }] =
      await Promise.all([
        import('./firebase.js'),
        import('./rankings-firestore.js'),
        import('./owner-auth-firestore.js'),
      ]);
    const connection = createRankingsFirestore();
    const store = new FirestoreRankingsStore(connection.firestore, connection.documentPath);
    return {
      store: {
        read: () => store.read(),
        save: (data) => store.save(data),
        close: connection.close,
      },
      ownerAuth: new FirestoreOwnerAuthStore(connection.firestore, connection.documentPath),
    };
  } catch (error) {
    if (error instanceof RankingsStorageError) throw error;
    throw new RankingsStorageError(
      error instanceof Error
        ? error.message
        : 'Firestore configuration is invalid. Check the server settings.',
    );
  }
}
