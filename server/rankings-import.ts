import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateRankings, type RankingsData } from '../src/rankings/model';
import { createRankingsStore } from './rankings-storage';
import { RankingsStorageError, type RankingsStore } from './rankings-store';

/** Import is explicit and atomic. Existing remote records are never merged or overwritten. */
export async function importRankings(store: RankingsStore, input: unknown, apply = false) {
  const source = validateRankings(input);
  if (source.players.length + source.games.length > 449) {
    throw new RankingsStorageError(
      'This import exceeds 449 player/game records. No records were written. A larger import requires a separately planned migration.',
    );
  }
  const current = await store.read();
  if (current.revision !== 0 || current.players.length || current.games.length) {
    throw new RankingsStorageError(
      'The Firestore ledger is already initialized. Import refused to protect existing records.',
    );
  }
  const data: RankingsData = { ...source, revision: current.revision };
  if (apply && (data.players.length || data.games.length)) {
    return { applied: true, data: await store.save(data) };
  }
  return { applied: false, data };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.info(
      'Usage: npm run rankings:import -- --file /path/to/rankings.json [--apply]\nDefaults to a read-only preview. --apply imports atomically into an empty Firestore ledger.',
    );
    return;
  }
  let sourcePath: string | undefined;
  let apply = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--file' && !sourcePath) sourcePath = args[++index];
    else if (args[index] === '--apply' && !apply) apply = true;
    else
      throw new Error(
        'Unknown argument. Use --file /path/to/rankings.json and optionally --apply.',
      );
  }
  if (!sourcePath || sourcePath.startsWith('--'))
    throw new Error('Supply --file /path/to/rankings.json.');
  if (process.env.RANKINGS_STORAGE !== 'firestore')
    throw new Error('Set RANKINGS_STORAGE=firestore before running the importer.');
  let source: RankingsData;
  try {
    source = validateRankings(JSON.parse(readFileSync(path.resolve(sourcePath), 'utf8')));
  } catch {
    throw new Error(
      'The import file is missing or is not a valid Catan rankings backup. No records were changed.',
    );
  }
  const store = await createRankingsStore(process.env.CATAN_DATA_DIR ?? 'server/data');
  try {
    const result = await importRankings(store, source, apply);
    console.info(
      `${result.applied ? 'Imported' : 'Preview'}: ${result.data.players.length} players and ${result.data.games.length} games.`,
    );
    if (!result.applied)
      console.info(
        apply
          ? 'The source is empty; nothing was written.'
          : 'No data was written. Repeat with --apply to import into this empty ledger.',
      );
    console.info('The source JSON file has not been modified.');
  } finally {
    await store.close?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Rankings import failed.');
    process.exitCode = 1;
  });
}
