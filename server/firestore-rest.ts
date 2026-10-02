import { randomBytes } from 'node:crypto';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';

type Data = Record<string, unknown>;
type Value = Record<string, unknown>;
type Fields = Record<string, Value>;
interface WireDocument {
  name: string;
  fields?: Fields;
  createTime?: string;
  updateTime?: string;
}
interface Write {
  update?: { name: string; fields: Fields };
  delete?: string;
  currentDocument?: { exists: boolean };
}
export interface FirestoreRestOptions {
  projectId: string;
  databaseId?: string;
  emulatorHost?: string;
  getToken(): Promise<string>;
}

const CODES: Record<number, string> = {
  3: 'INVALID_ARGUMENT',
  5: 'NOT_FOUND',
  6: 'ALREADY_EXISTS',
  7: 'PERMISSION_DENIED',
  8: 'RESOURCE_EXHAUSTED',
  9: 'FAILED_PRECONDITION',
  10: 'ABORTED',
  13: 'INTERNAL',
  14: 'UNAVAILABLE',
  16: 'UNAUTHENTICATED',
};
const SAFE_CODES = new Set([...Object.values(CODES), 'DEADLINE_EXCEEDED', 'UNKNOWN']);
/** Deliberately omits Firebase messages, URLs, request bodies, and authorization values. */
export class FirestoreRestError extends Error {
  constructor(
    readonly code: string,
    readonly status = 503,
  ) {
    super(
      code === 'ABORTED'
        ? 'Firestore transaction conflicted with another request.'
        : `Firestore request failed (${SAFE_CODES.has(code) ? code : 'UNKNOWN'}).`,
    );
    this.name = 'FirestoreRestError';
  }
}
function invalid(): never {
  throw new FirestoreRestError('INVALID_ARGUMENT', 400);
}
function record(value: unknown): value is Data {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function safeFields(): Fields {
  return Object.create(null) as Fields;
}
function validatePath(path: string, document: boolean): string {
  if (typeof path !== 'string') return invalid();
  const parts = path.split('/');
  if (
    !parts.length ||
    parts.length > 100 ||
    (parts.length % 2 === 0) !== document ||
    parts.some(
      (part) =>
        !part ||
        part !== part.trim() ||
        part === '.' ||
        part === '..' ||
        /^__.*__$/.test(part) ||
        /[\u0000-\u001f\u007f]/.test(part) ||
        Buffer.byteLength(part) > 1500,
    )
  )
    return invalid();
  return path;
}
function timestampText(timestamp: Timestamp): string {
  const date = new Date(timestamp.seconds * 1000).toISOString();
  return `${date.slice(0, date.indexOf('.'))}.${String(timestamp.nanoseconds).padStart(9, '0')}Z`;
}
function timestamp(value: unknown): Timestamp {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  )
    return invalid();
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return invalid();
  const fraction = /\.(\d+)/.exec(value)?.[1] ?? '';
  return new Timestamp(Math.floor(milliseconds / 1000), Number(fraction.padEnd(9, '0')));
}
function encode(value: unknown, ancestors: Set<object>, depth: number, arrayChild = false): Value {
  if (depth > 20) return invalid();
  if (value === null) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      return { doubleValue: Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity' };
    return Number.isSafeInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (value instanceof Timestamp) return { timestampValue: timestampText(value) };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (Buffer.isBuffer(value) || value instanceof Uint8Array)
    return { bytesValue: Buffer.from(value).toString('base64') };
  if (!value || typeof value !== 'object' || ancestors.has(value)) return invalid();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (arrayChild) return invalid();
      return {
        arrayValue: { values: value.map((item) => encode(item, ancestors, depth + 1, true)) },
      };
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      return invalid();
    return { mapValue: { fields: encodeFields(value as Data, ancestors, depth + 1) } };
  } finally {
    ancestors.delete(value);
  }
}
function encodeFields(data: Data, ancestors = new Set<object>(), depth = 0): Fields {
  if (!record(data)) return invalid();
  const fields = safeFields();
  for (const [key, value] of Object.entries(data)) {
    if (!key || Buffer.byteLength(key) > 1500 || /^__.*__$/.test(key)) return invalid();
    fields[key] = encode(value, ancestors, depth);
  }
  return fields;
}
function decode(value: unknown, depth = 0): unknown {
  if (!record(value) || depth > 20 || Object.keys(value).length !== 1) return invalid();
  if ('nullValue' in value) return null;
  if ('stringValue' in value && typeof value.stringValue === 'string') return value.stringValue;
  if ('booleanValue' in value && typeof value.booleanValue === 'boolean') return value.booleanValue;
  if (
    'integerValue' in value &&
    (typeof value.integerValue === 'string' || typeof value.integerValue === 'number')
  ) {
    if (!/^-?\d+$/.test(String(value.integerValue))) return invalid();
    const result = Number(value.integerValue);
    if (!Number.isSafeInteger(result)) return invalid();
    return result;
  }
  if ('doubleValue' in value) {
    if (typeof value.doubleValue === 'number') return value.doubleValue;
    if (value.doubleValue === 'NaN') return NaN;
    if (value.doubleValue === 'Infinity') return Infinity;
    if (value.doubleValue === '-Infinity') return -Infinity;
    return invalid();
  }
  if ('timestampValue' in value) return timestamp(value.timestampValue);
  if ('bytesValue' in value && typeof value.bytesValue === 'string')
    return Buffer.from(value.bytesValue, 'base64');
  if ('arrayValue' in value && record(value.arrayValue)) {
    const items = value.arrayValue.values ?? [];
    if (!Array.isArray(items)) return invalid();
    return items.map((item) => decode(item, depth + 1));
  }
  if ('mapValue' in value && record(value.mapValue))
    return decodeFields(value.mapValue.fields ?? {}, depth + 1);
  return invalid();
}
function decodeFields(value: unknown, depth = 0): Data {
  if (!record(value)) return invalid();
  const result: Data = {};
  for (const [key, item] of Object.entries(value))
    Object.defineProperty(result, key, {
      value: decode(item, depth),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return result;
}
class DocumentSnapshot {
  readonly exists: boolean;
  readonly id: string;
  readonly createTime?: Timestamp;
  readonly updateTime?: Timestamp;
  constructor(
    readonly ref: DocumentReference,
    private readonly document?: WireDocument,
  ) {
    this.exists = !!document;
    this.id = ref.id;
    this.createTime = document?.createTime ? timestamp(document.createTime) : undefined;
    this.updateTime = document?.updateTime ? timestamp(document.updateTime) : undefined;
  }
  data(): Data | undefined {
    return this.document ? decodeFields(this.document.fields ?? {}) : undefined;
  }
  get(field: string): unknown {
    let value: unknown = this.data();
    for (const part of field.split('.')) value = record(value) ? value[part] : undefined;
    return value;
  }
}
class QuerySnapshot {
  readonly size: number;
  readonly empty: boolean;
  constructor(readonly docs: DocumentSnapshot[]) {
    this.size = docs.length;
    this.empty = !docs.length;
  }
  forEach(callback: (document: DocumentSnapshot) => void): void {
    this.docs.forEach(callback);
  }
}
class DocumentReference {
  readonly id: string;
  constructor(
    readonly owner: RestFirestore,
    readonly path: string,
  ) {
    validatePath(path, true);
    this.id = path.split('/').at(-1)!;
  }
  collection(path: string): CollectionReference {
    return this.owner.collection(`${this.path}/${path}`);
  }
  get(): Promise<DocumentSnapshot> {
    return this.owner.readDocument(this);
  }
  async set(data: Data, options?: unknown): Promise<void> {
    if (options !== undefined) return invalid();
    await this.owner.batch().set(this, data).commit();
  }
  async delete(): Promise<void> {
    await this.owner.batch().delete(this).commit();
  }
}
class Query {
  constructor(
    readonly owner: RestFirestore,
    readonly path: string,
    readonly maximum?: number,
  ) {
    validatePath(path, false);
  }
  limit(maximum: number): Query {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 10_000) return invalid();
    return new Query(this.owner, this.path, maximum);
  }
  get(): Promise<QuerySnapshot> {
    return this.owner.readQuery(this);
  }
}
class CollectionReference extends Query {
  readonly id: string;
  constructor(owner: RestFirestore, path: string) {
    super(owner, path);
    this.id = path.split('/').at(-1)!;
  }
  doc(path = randomBytes(15).toString('hex')): DocumentReference {
    return this.owner.doc(`${this.path}/${path}`);
  }
}
class WriteBatch {
  protected readonly writes: Write[] = [];
  protected ended = false;
  constructor(protected readonly owner: RestFirestore) {}
  protected append(reference: DocumentReference, data?: Data, create = false): this {
    this.owner.assertOwned(reference);
    if (this.ended || this.writes.length >= 500) return invalid();
    const write: Write =
      data === undefined
        ? { delete: this.owner.name(reference.path) }
        : { update: { name: this.owner.name(reference.path), fields: encodeFields(data) } };
    if (create) write.currentDocument = { exists: false };
    this.writes.push(write);
    return this;
  }
  set(reference: DocumentReference, data: Data, options?: unknown): this {
    if (options !== undefined || data === undefined) return invalid();
    return this.append(reference, data);
  }
  delete(reference: DocumentReference): this {
    return this.append(reference);
  }
  create(reference: DocumentReference, data: Data): this {
    if (data === undefined) return invalid();
    return this.append(reference, data, true);
  }
  async commit(): Promise<void> {
    if (this.ended) return invalid();
    this.ended = true;
    await this.owner.commit(this.writes);
  }
}
class Transaction extends WriteBatch {
  private pendingReads = 0;
  constructor(
    owner: RestFirestore,
    readonly token: string,
    readonly readOnly: boolean,
  ) {
    super(owner);
  }
  async get(reference: DocumentReference): Promise<DocumentSnapshot>;
  async get(reference: Query): Promise<QuerySnapshot>;
  async get(reference: DocumentReference | Query): Promise<DocumentSnapshot | QuerySnapshot> {
    this.owner.assertOwned(reference);
    if (this.ended || this.writes.length) return invalid();
    this.pendingReads++;
    try {
      return reference instanceof DocumentReference
        ? await this.owner.readDocument(reference, this.token)
        : await this.owner.readQuery(reference, this.token);
    } finally {
      this.pendingReads--;
    }
  }
  protected override append(reference: DocumentReference, data?: Data, create = false): this {
    if (this.readOnly || this.pendingReads) return invalid();
    return super.append(reference, data, create);
  }
  override async commit(): Promise<void> {
    if (this.ended || this.pendingReads) return invalid();
    this.ended = true;
    await this.owner.commit(this.writes, this.token);
  }
  finish(): void {
    this.ended = true;
  }
}
class RestFirestore {
  readonly projectId: string;
  readonly databaseId: string;
  private readonly resource: string;
  private readonly base: string;
  private stopped = false;
  constructor(private readonly options: FirestoreRestOptions) {
    const { projectId, emulatorHost } = options;
    const databaseId = options.databaseId ?? '(default)';
    if (
      !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId) ||
      (databaseId !== '(default)' && !/^[a-z][a-z0-9-]{2,61}[a-z0-9]$/.test(databaseId)) ||
      typeof options.getToken !== 'function'
    )
      invalid();
    let origin = 'https://firestore.googleapis.com';
    if (emulatorHost !== undefined) {
      if (
        process.env.NODE_ENV === 'production' ||
        !projectId.startsWith('demo-') ||
        !/^(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/.test(emulatorHost)
      )
        invalid();
      const port = Number(emulatorHost.slice(emulatorHost.lastIndexOf(':') + 1));
      if (port < 1 || port > 65535) invalid();
      origin = `http://${emulatorHost}`;
    } else if (projectId.startsWith('demo-')) invalid();
    this.projectId = projectId;
    this.databaseId = databaseId;
    this.resource = `projects/${projectId}/databases/${databaseId}/documents`;
    this.base = `${origin}/v1/${this.resource}`;
  }
  name(path: string): string {
    return `${this.resource}/${path}`;
  }
  private suffix(path: string): string {
    return path.split('/').map(encodeURIComponent).join('/');
  }
  assertOwned(reference: unknown): asserts reference is DocumentReference | Query {
    if (
      !(reference instanceof DocumentReference || reference instanceof Query) ||
      reference.owner !== this
    )
      return invalid();
  }
  doc(path: string): DocumentReference {
    return new DocumentReference(this, path);
  }
  collection(path: string): CollectionReference {
    return new CollectionReference(this, path);
  }
  batch(): WriteBatch {
    return new WriteBatch(this);
  }
  async terminate(): Promise<void> {
    this.stopped = true;
  }
  private async request(suffix: string, body: unknown, method = 'POST'): Promise<unknown> {
    if (this.stopped) throw new FirestoreRestError('FAILED_PRECONDITION');
    let token: string;
    try {
      token = await this.options.getToken();
    } catch {
      throw new FirestoreRestError('UNAUTHENTICATED', 401);
    }
    if (typeof token !== 'string' || !token || token.length > 16_384 || /\s/.test(token))
      throw new FirestoreRestError('UNAUTHENTICATED', 401);
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    if (serialized && Buffer.byteLength(serialized) > 9 * 1024 * 1024) return invalid();
    let response: Response;
    try {
      response = await fetch(`${this.base}${suffix}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(12_000),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(serialized === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(serialized === undefined ? {} : { body: serialized }),
      });
    } catch {
      throw new FirestoreRestError('UNAVAILABLE');
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new FirestoreRestError('UNKNOWN', response.status);
    }
    const problem =
      record(value) && record(value.error)
        ? value.error
        : Array.isArray(value)
          ? value.find((entry) => record(entry) && record(entry.error))?.error
          : undefined;
    if (!response.ok || problem) {
      const code =
        problem && typeof problem.status === 'string' && SAFE_CODES.has(problem.status)
          ? problem.status
          : problem && typeof problem.code === 'number'
            ? (CODES[problem.code] ?? 'UNKNOWN')
            : response.status === 404
              ? 'NOT_FOUND'
              : 'UNKNOWN';
      throw new FirestoreRestError(code, response.status);
    }
    return value;
  }
  private wireDocument(value: unknown, path?: string): WireDocument {
    if (
      !record(value) ||
      typeof value.name !== 'string' ||
      !value.name.startsWith(`${this.resource}/`)
    )
      return invalid();
    const actual = value.name.slice(this.resource.length + 1);
    validatePath(actual, true);
    if (path !== undefined && actual !== path) return invalid();
    if (value.fields !== undefined && !record(value.fields)) return invalid();
    return value as unknown as WireDocument;
  }
  async readDocument(ref: DocumentReference, transaction?: string): Promise<DocumentSnapshot> {
    this.assertOwned(ref);
    if (transaction) {
      const result = await this.request(':batchGet', {
        documents: [this.name(ref.path)],
        transaction,
      });
      if (!Array.isArray(result)) return invalid();
      const found = result.find((row) => record(row) && (row.found || row.missing));
      if (!record(found)) return invalid();
      if (found.found) return new DocumentSnapshot(ref, this.wireDocument(found.found, ref.path));
      if (found.missing !== this.name(ref.path)) return invalid();
      return new DocumentSnapshot(ref);
    }
    try {
      return new DocumentSnapshot(
        ref,
        this.wireDocument(
          await this.request(`/${this.suffix(ref.path)}`, undefined, 'GET'),
          ref.path,
        ),
      );
    } catch (error) {
      if (error instanceof FirestoreRestError && error.code === 'NOT_FOUND')
        return new DocumentSnapshot(ref);
      throw error;
    }
  }
  async readQuery(query: Query, transaction?: string): Promise<QuerySnapshot> {
    this.assertOwned(query);
    const parts = query.path.split('/');
    const collectionId = parts.pop()!;
    const parent = parts.length ? `/${this.suffix(parts.join('/'))}` : '';
    const result = await this.request(`${parent}:runQuery`, {
      structuredQuery: {
        from: [{ collectionId }],
        ...(query.maximum === undefined ? {} : { limit: query.maximum }),
      },
      ...(transaction ? { transaction } : {}),
    });
    if (!Array.isArray(result)) return invalid();
    const documents: DocumentSnapshot[] = [];
    for (const row of result) {
      if (!record(row)) return invalid();
      if (!row.document) continue;
      const document = this.wireDocument(row.document);
      const path = document.name.slice(this.resource.length + 1);
      if (path.split('/').slice(0, -1).join('/') !== query.path) return invalid();
      documents.push(new DocumentSnapshot(this.doc(path), document));
    }
    return new QuerySnapshot(documents);
  }
  async commit(writes: Write[], transaction?: string): Promise<void> {
    await this.request(':commit', { writes, ...(transaction ? { transaction } : {}) });
  }
  async runTransaction<T>(
    work: (transaction: Transaction) => Promise<T>,
    options: { readOnly?: boolean } = {},
  ): Promise<T> {
    for (let attempt = 0; attempt < 5; attempt++) {
      let transaction: Transaction | undefined;
      try {
        const result = await this.request(':beginTransaction', {
          options: options.readOnly ? { readOnly: {} } : { readWrite: {} },
        });
        if (
          !record(result) ||
          typeof result.transaction !== 'string' ||
          !result.transaction ||
          result.transaction.length > 16_384
        )
          return invalid();
        transaction = new Transaction(this, result.transaction, !!options.readOnly);
        const value = await work(transaction);
        await transaction.commit();
        return value;
      } catch (error) {
        if (transaction) {
          transaction.finish();
          // Rollback is cleanup only: it must never replace an uncertain commit outcome.
          try {
            await this.request(':rollback', { transaction: transaction.token });
          } catch {}
        }
        if (!(error instanceof FirestoreRestError) || error.code !== 'ABORTED' || attempt === 4)
          throw error;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(400, 25 * 2 ** attempt) + Math.floor(Math.random() * 30)),
        );
      }
    }
    throw new FirestoreRestError('ABORTED', 409);
  }
}

/**
 * Narrow compatibility boundary for Catan's existing stores. This implements only
 * their documented document/query/transaction/batch operations, not the full Admin SDK.
 * Google OAuth tokens use IAM authorization; Firebase ID tokens use Security Rules.
 * The caller supplies the appropriate server identity; this adapter never grants access.
 */
export function createFirestoreRest(options: FirestoreRestOptions): Firestore {
  return new RestFirestore(options) as unknown as Firestore;
}
