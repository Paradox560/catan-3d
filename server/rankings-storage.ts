import { FileRankingsStore, RankingsStorageError, type RankingsStore } from './rankings-store';

export async function createRankingsStore(directory: string): Promise<RankingsStore> {
  const storage = process.env.RANKINGS_STORAGE ?? 'file';
  if (storage === 'file') return new FileRankingsStore(directory);
  if (storage !== 'firestore') {
    throw new RankingsStorageError(
      'RANKINGS_STORAGE must be file or firestore. No records have been changed.',
    );
  }
  if (
    process.env.NODE_ENV === 'production' &&
    (!process.env.RANKINGS_ADMIN_PASSWORD || process.env.RANKINGS_ADMIN_PASSWORD.length < 10)
  ) {
    throw new RankingsStorageError(
      'Set RANKINGS_ADMIN_PASSWORD to a private password of at least 10 characters before using Firestore in production.',
    );
  }
  try {
    const [{ createRankingsFirestore }, { FirestoreRankingsStore }] = await Promise.all([
      import('./firebase'),
      import('./rankings-firestore'),
    ]);
    const connection = createRankingsFirestore();
    const store = new FirestoreRankingsStore(connection.firestore, connection.documentPath);
    return { read: () => store.read(), save: (data) => store.save(data), close: connection.close };
  } catch (error) {
    if (error instanceof RankingsStorageError) throw error;
    throw new RankingsStorageError(
      error instanceof Error
        ? error.message
        : 'Firestore configuration is invalid. Check the server settings.',
    );
  }
}
