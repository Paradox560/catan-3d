import type {
  DocumentReference,
  Firestore,
  QuerySnapshot,
  Transaction,
} from 'firebase-admin/firestore';
import {
  emptyRankings,
  validateRankings,
  type RankedPlayer,
  type RankingsData,
  type RecordedGame,
} from '../src/rankings/model';
import { RankingsConflictError, RankingsStorageError, type RankingsStore } from './rankings-store';

const SCHEMA = 'catan-rankings-v1';
const MAX_WRITES = 450;
const MAX_WRITE_BYTES = 8 * 1024 * 1024;
const CORRUPT_MESSAGE =
  'The Firestore rankings are invalid or incomplete. No records were changed. Restore the ledger from a backup before saving.';

type RankingRecord = RankedPlayer | RecordedGame;
type RecordWrite =
  | { kind: 'set'; ref: DocumentReference; data: RankingRecord; previous?: RankingRecord }
  | { kind: 'delete'; ref: DocumentReference; previous: RankingRecord };

function documentRecords(snapshot: QuerySnapshot): Map<string, unknown> {
  return new Map(
    snapshot.docs.map((document) => {
      const data = document.data();
      if (data.id !== document.id) throw new RankingsStorageError(CORRUPT_MESSAGE);
      return [document.id, data];
    }),
  );
}

function orderedRecords(ids: unknown, records: Map<string, unknown>, maximum: number): unknown[] {
  if (
    !Array.isArray(ids) ||
    ids.length > maximum ||
    ids.length !== records.size ||
    ids.some((id) => typeof id !== 'string' || !records.has(id)) ||
    new Set(ids).size !== ids.length
  ) {
    throw new RankingsStorageError(CORRUPT_MESSAGE);
  }
  return ids.map((id) => records.get(id));
}

function safeFailure(error: unknown, operation: 'read' | 'save'): never {
  if (error instanceof RankingsStorageError || error instanceof RankingsConflictError) throw error;
  // Firebase errors can contain project paths or credential details. Never expose those to clients.
  throw new RankingsStorageError(
    operation === 'read'
      ? 'Could not load rankings from Firestore. Check the server connection and Firebase configuration, then retry.'
      : 'Could not save rankings to Firestore. Your changes were not confirmed; refresh the rankings before retrying.',
  );
}

/** One reserved ledger document and separate player/game documents, committed atomically. */
export class FirestoreRankingsStore implements RankingsStore {
  private readonly ledger: DocumentReference;

  constructor(
    private readonly firestore: Firestore,
    ledgerDocumentPath: string,
  ) {
    try {
      const segments = ledgerDocumentPath.split('/');
      if (
        !ledgerDocumentPath ||
        ledgerDocumentPath !== ledgerDocumentPath.trim() ||
        segments.length % 2 !== 0 ||
        segments.some((segment) => !segment || segment === '.' || segment === '..')
      ) {
        throw new Error('Invalid document path');
      }
      this.ledger = firestore.doc(ledgerDocumentPath);
    } catch {
      throw new RankingsStorageError(
        'FIRESTORE_RANKINGS_DOCUMENT must be a complete Firestore document path, such as catan/rankings.',
      );
    }
  }

  private async snapshot(transaction: Transaction): Promise<RankingsData> {
    const metadata = await transaction.get(this.ledger);
    const [playersSnapshot, gamesSnapshot] = await Promise.all([
      transaction.get(this.ledger.collection('players').limit(501)),
      transaction.get(this.ledger.collection('games').limit(2001)),
    ]);
    if (!metadata.exists) {
      if (!playersSnapshot.empty || !gamesSnapshot.empty) {
        throw new RankingsStorageError(CORRUPT_MESSAGE);
      }
      return emptyRankings();
    }
    const fields = metadata.data();
    if (fields?.schema !== SCHEMA) {
      throw new RankingsStorageError(
        'The configured Firestore document already contains data that is not a Catan rankings ledger. Choose an unused document path; no records were changed.',
      );
    }
    try {
      return validateRankings({
        version: fields.version,
        revision: fields.revision,
        players: orderedRecords(fields.playerIds, documentRecords(playersSnapshot), 500),
        games: orderedRecords(fields.gameIds, documentRecords(gamesSnapshot), 2000),
      });
    } catch {
      throw new RankingsStorageError(CORRUPT_MESSAGE);
    }
  }

  async read(): Promise<RankingsData> {
    try {
      // A read-only transaction prevents a response assembled from different ledger revisions.
      return await this.firestore.runTransaction((transaction) => this.snapshot(transaction), {
        readOnly: true,
      });
    } catch (error) {
      return safeFailure(error, 'read');
    }
  }

  async save(input: RankingsData): Promise<RankingsData> {
    let next: RankingsData;
    try {
      next = validateRankings(input);
    } catch {
      throw new RankingsStorageError('The supplied rankings are invalid. No records were changed.');
    }
    try {
      return await this.firestore.runTransaction(async (transaction) => {
        const current = await this.snapshot(transaction);
        if (current.revision !== next.revision) throw new RankingsConflictError();
        if (current.revision === Number.MAX_SAFE_INTEGER) {
          throw new RankingsStorageError(
            'The rankings revision limit has been reached. No records were changed.',
          );
        }
        const saved: RankingsData = { ...next, revision: current.revision + 1 };
        const metadata = {
          schema: SCHEMA,
          version: saved.version,
          revision: saved.revision,
          playerIds: saved.players.map((player) => player.id),
          gameIds: saved.games.map((game) => game.id),
        };
        const writes: RecordWrite[] = [];
        const collect = (collection: string, before: RankingRecord[], after: RankingRecord[]) => {
          const previous = new Map(before.map((record) => [record.id, record]));
          for (const record of after) {
            const old = previous.get(record.id);
            previous.delete(record.id);
            if (JSON.stringify(old) !== JSON.stringify(record)) {
              writes.push({
                kind: 'set',
                ref: this.ledger.collection(collection).doc(record.id),
                data: record,
                previous: old,
              });
            }
          }
          for (const record of previous.values()) {
            writes.push({
              kind: 'delete',
              ref: this.ledger.collection(collection).doc(record.id),
              previous: record,
            });
          }
        };
        collect('players', current.players, saved.players);
        collect('games', current.games, saved.games);

        if (writes.length + 1 > MAX_WRITES) {
          throw new RankingsStorageError(
            'This update changes too many records at once. Save at most 449 changed players or games per update.',
          );
        }
        // Leave room beneath Firestore's request limit for document names, protobuf encoding,
        // and index updates. Include deleted/previous values because their indexes also change.
        let estimatedBytes = 1024 + Buffer.byteLength(JSON.stringify(metadata)) * 2;
        for (const write of writes) {
          estimatedBytes +=
            1024 +
            Buffer.byteLength(write.ref.path) * 2 +
            Buffer.byteLength(JSON.stringify(write.previous ?? null)) * 2;
          if (write.kind === 'set') {
            estimatedBytes += Buffer.byteLength(JSON.stringify(write.data)) * 2;
          }
        }
        if (estimatedBytes > MAX_WRITE_BYTES) {
          throw new RankingsStorageError(
            'This update is too large for one Firestore transaction. Save fewer changes at a time.',
          );
        }
        // All reads and validation must finish before the first write is queued.
        for (const write of writes) {
          if (write.kind === 'set') transaction.set(write.ref, write.data);
          else transaction.delete(write.ref);
        }
        transaction.set(this.ledger, metadata);
        return saved;
      });
    } catch (error) {
      return safeFailure(error, 'save');
    }
  }
}
