import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { emptyBreakdown, emptyRankings, type RankingsData } from '../src/rankings/model';
import { FileRankingsStore } from './rankings-store';
import { importRankings } from './rankings-import';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function destination() {
  const directory = mkdtempSync(path.join(tmpdir(), 'catan-import-test-'));
  directories.push(directory);
  return { directory, store: new FileRankingsStore(directory) };
}
const source = (): RankingsData => ({
  version: 1,
  revision: 27,
  players: [
    { id: 'alice', name: 'Alice' },
    { id: 'bob', name: 'Bob' },
  ],
  games: [
    {
      id: 'first',
      date: '2026-10-01',
      notes: 'Tabletop game',
      results: [
        { playerId: 'alice', breakdown: { ...emptyBreakdown(), settlements: 4, cities: 3 } },
        { playerId: 'bob', breakdown: { ...emptyBreakdown(), settlements: 2, cities: 2 } },
      ],
    },
  ],
});
describe('safe rankings import', () => {
  test('preview is read-only and preserves source revision', async () => {
    const { directory, store } = destination();
    const input = source();
    const result = await importRankings(store, input);
    expect(result.applied).toBe(false);
    expect(await store.read()).toEqual(emptyRankings());
    expect(existsSync(path.join(directory, 'rankings.json'))).toBe(false);
    expect(input.revision).toBe(27);
  });
  test('apply imports the complete ledger once and survives a new process store', async () => {
    const { directory, store } = destination();
    const result = await importRankings(store, source(), true);
    expect(result.applied).toBe(true);
    expect(await new FileRankingsStore(directory).read()).toEqual({ ...source(), revision: 1 });
    await expect(importRankings(store, source(), true)).rejects.toThrow('already initialized');
    expect(await store.read()).toEqual(result.data);
  });
  test('invalid or oversized sources leave the destination empty', async () => {
    const { store } = destination();
    const invalid = source();
    invalid.games[0].results[0].playerId = 'unknown';
    await expect(importRankings(store, invalid, true)).rejects.toThrow('unknown player');
    const large = emptyRankings();
    large.players = Array.from({ length: 450 }, (_, index) => ({
      id: `p${index}`,
      name: `Player ${index}`,
    }));
    await expect(importRankings(store, large, true)).rejects.toThrow('exceeds 449');
    expect(await store.read()).toEqual(emptyRankings());
  });
  test('empty source does not initialize or write a ledger', async () => {
    const { directory, store } = destination();
    expect((await importRankings(store, emptyRankings(), true)).applied).toBe(false);
    expect(existsSync(path.join(directory, 'rankings.json'))).toBe(false);
  });
});
