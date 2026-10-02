import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { emptyRankings, validateRankings, type RankingsData } from '../src/rankings/model.js';

export interface RankingsStore {
  read(): Promise<RankingsData>;
  save(next: RankingsData): Promise<RankingsData>;
  close?(): Promise<void>;
}

export class RankingsConflictError extends Error {
  constructor(
    message = 'Rankings changed in another tab. Reload the latest records before saving.',
  ) {
    super(message);
    this.name = 'RankingsConflictError';
  }
}

export class RankingsStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RankingsStorageError';
  }
}

/** Local development storage. A configured remote store never falls back to this file. */
export class FileRankingsStore implements RankingsStore {
  private data: RankingsData = emptyRankings();
  private readonly file: string;

  constructor(directory: string) {
    this.file = path.join(directory, 'rankings.json');
    try {
      if (existsSync(this.file)) {
        this.data = validateRankings(JSON.parse(readFileSync(this.file, 'utf8')));
        chmodSync(this.file, 0o600);
      }
    } catch {
      throw new RankingsStorageError(
        'The saved rankings could not be read. Restore or repair rankings.json before editing; the existing file has been preserved.',
      );
    }
  }

  async read(): Promise<RankingsData> {
    return validateRankings(this.data);
  }

  async save(input: RankingsData): Promise<RankingsData> {
    const next = validateRankings(input);
    if (next.revision !== this.data.revision) throw new RankingsConflictError();
    if (this.data.revision === Number.MAX_SAFE_INTEGER) {
      throw new RankingsStorageError(
        'The rankings revision limit has been reached. Export the ledger before resetting its revision.',
      );
    }
    next.revision++;
    const temporary = `${this.file}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.file);
      this.data = next;
    } catch {
      throw new RankingsStorageError(
        'Could not save rankings. Your changes were not applied; check the server data directory permissions.',
      );
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
    return validateRankings(this.data);
  }
}
