import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRankingsServices } from './rankings-storage';
import { FileRankingsStore } from './rankings-store';

const fixture = vi.hoisted(() => ({
  connect: vi.fn(),
  read: vi.fn(),
  save: vi.fn(),
  close: vi.fn(),
}));
vi.mock('./firebase.js', () => ({ createRankingsFirestore: fixture.connect }));
vi.mock('./rankings-firestore.js', () => ({
  FirestoreRankingsStore: class {
    read = fixture.read;
    save = fixture.save;
  },
}));
vi.mock('./owner-auth-firestore.js', () => ({ FirestoreOwnerAuthStore: class {} }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('RANKINGS_STORAGE', undefined);
  vi.stubEnv('VERCEL', undefined);
  fixture.connect.mockReturnValue({
    firestore: {},
    documentPath: 'catan/rankings',
    close: fixture.close,
  });
});
afterEach(() => vi.unstubAllEnvs());

describe('hosted rankings storage', () => {
  it('defaults to persistent Firestore on Vercel without another environment variable', async () => {
    vi.stubEnv('VERCEL', '1');
    const { store } = await createRankingsServices('/unused-test-directory');
    expect(fixture.connect).toHaveBeenCalledOnce();
    await store.read();
    expect(fixture.read).toHaveBeenCalledOnce();
    await store.close?.();
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it('never falls back to ephemeral files when cloud configuration fails', async () => {
    vi.stubEnv('VERCEL', '1');
    fixture.connect.mockImplementationOnce(() => {
      throw new Error('Missing web configuration.');
    });
    await expect(createRankingsServices('/unused-test-directory')).rejects.toThrow(
      'Missing web configuration.',
    );
  });

  it('rejects an explicit file-store choice on Vercel', async () => {
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('RANKINGS_STORAGE', 'file');
    await expect(createRankingsServices('/unused-test-directory')).rejects.toThrow(
      'Vercel requires Firestore',
    );
    expect(fixture.connect).not.toHaveBeenCalled();
  });

  it('keeps local development available without Firebase', async () => {
    const { store } = await createRankingsServices('/unused-test-directory');
    expect(store).toBeInstanceOf(FileRankingsStore);
    expect(fixture.connect).not.toHaveBeenCalled();
  });

  it('still supports an explicitly configured Firestore connection outside Vercel', async () => {
    vi.stubEnv('RANKINGS_STORAGE', 'firestore');
    await createRankingsServices('/unused-test-directory');
    expect(fixture.connect).toHaveBeenCalledOnce();
  });
});
