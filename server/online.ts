import express, { type Request, type Response, type NextFunction } from 'express';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { createRankingsFirestore } from './firebase.js';
import { applyAction, createGame } from '../src/game/engine.js';
import type { GameState } from '../src/game/types.js';
import type { PendingTrade, RoomSnapshot, Session } from '../src/network.js';
import {
  assert,
  emptyResources,
  integer,
  object,
  OnlineError,
  parseAction,
  playerName,
  RESOURCE_NAMES,
  resources,
  roomCode,
  total,
} from './online-validation.js';

const TTL = 72 * 60 * 60 * 1000;
const LEASE = 75_000;
const HEARTBEAT = 30_000;
const SCHEMA = 'catan-online-room-v1';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const randomRng = () => randomBytes(4).readUInt32LE(0) || 1;
interface Seat {
  id: number;
  name: string;
  tokenHash: string;
  connectionHash: string;
  leaseUntil: number;
}
export interface OnlineRoom {
  code: string;
  mode: 'standard' | 'extension';
  capacity: number;
  host: number;
  players: Seat[];
  game: GameState | null;
  pendingTrade: PendingTrade | null;
  revision: number;
  updatedAt: number;
}
interface Identity {
  token: string;
  connection: string;
}
export interface OnlineReply {
  ok: true;
  state: RoomSnapshot;
  session?: Session;
}

function readRoom(value: FirebaseFirestore.DocumentData | undefined, now: number): OnlineRoom {
  if (!value)
    throw new OnlineError(
      'This room has expired or could not be found. Check the code with your host.',
      404,
    );
  try {
    assert(value.schema === SCHEMA && typeof value.state === 'string', 'Invalid room.');
    const room = JSON.parse(value.state) as OnlineRoom;
    assert(
      /^[A-Z2-9]{6}$/.test(room.code) &&
        Array.isArray(room.players) &&
        room.players.length <= 6 &&
        Number.isSafeInteger(room.revision),
      'Invalid room.',
    );
    assert(
      room.players.every(
        (p) => /^[a-f0-9]{64}$/.test(p.tokenHash) && /^[a-f0-9]{64}$/.test(p.connectionHash),
      ),
      'Invalid room.',
    );
    if (room.updatedAt < now - TTL)
      throw new OnlineError('This room has expired. Create a new game.', 410);
    return room;
  } catch (error) {
    if (error instanceof OnlineError && error.status === 410) throw error;
    throw new OnlineError('This room could not be loaded. No game data was changed.', 503);
  }
}
function encodeRoom(room: OnlineRoom) {
  const state = JSON.stringify(room);
  assert(Buffer.byteLength(state) < 900_000, 'This room has reached its storage limit.');
  return { schema: SCHEMA, state, expiresAt: Timestamp.fromMillis(room.updatedAt + TTL) };
}
function seatFor(room: OnlineRoom, identity: Identity, takeover = false): Seat {
  const token = digest(identity.token);
  const seat = room.players.find((p) =>
    timingSafeEqual(Buffer.from(p.tokenHash, 'hex'), Buffer.from(token, 'hex')),
  );
  if (!seat) throw new OnlineError('The saved session does not belong to this room.', 401);
  if (!takeover && seat.connectionHash !== digest(identity.connection))
    throw new OnlineError(
      'Your seat is now open in another tab. Use Resume game to take control here.',
      409,
    );
  return seat;
}
export function onlineSnapshot(room: OnlineRoom, player: number, now = Date.now()): RoomSnapshot {
  const game = room.game ? structuredClone(room.game) : null;
  const resourceCounts: Record<number, number> = {};
  const devCounts: Record<number, number> = {};
  if (game) {
    for (const p of game.players) {
      resourceCounts[p.id] = total(p.resources);
      devCounts[p.id] = p.devCards.length;
      if (p.id !== player) {
        p.resources = emptyResources();
        if (game.phase !== 'gameOver') p.devCards = [];
      }
    }
    game.deck = game.deck.map(() => 'victory');
    game.rng = 0;
    game.config.seed = 'online-private';
  }
  return {
    code: room.code,
    mode: room.mode,
    capacity: room.capacity,
    host: room.host,
    revision: room.revision,
    players: room.players.map((p) => ({ id: p.id, name: p.name, connected: p.leaseUntil > now })),
    game,
    you: player,
    resourceCounts,
    devCounts,
    pendingTrade: room.pendingTrade && room.pendingTrade.expiresAt > now ? room.pendingTrade : null,
  };
}

/** All authoritative state is transactional, so independent serverless instances share rooms. */
export class FirestoreOnlineRooms {
  private readonly rooms;
  private readonly limits;
  constructor(
    private readonly firestore: Firestore,
    documentPath: string,
  ) {
    this.rooms = firestore.doc(documentPath).collection('onlineRooms');
    this.limits = firestore.doc(documentPath).collection('onlineLimits');
  }
  async rateLimit(address: string, creation: boolean): Promise<void> {
    const now = Date.now();
    const window = creation ? 60 * 60_000 : 60_000;
    const maximum = creation ? 20 : 240;
    const ref = this.limits.doc(`${creation ? 'create' : 'write'}-${digest(address)}`);
    await this.firestore.runTransaction(async (tx) => {
      const previous = (await tx.get(ref)).data();
      const reset = previous && previous.reset > now ? (previous.reset as number) : now + window;
      const count = previous && previous.reset > now ? (previous.count as number) : 0;
      if (count >= maximum) throw new OnlineError('Please slow down and try again shortly.', 429);
      tx.set(ref, { count: count + 1, reset, expiresAt: Timestamp.fromMillis(reset) });
    });
  }
  async create(input: Record<string, unknown>, connection: string): Promise<OnlineReply> {
    const name = playerName(input.name);
    assert(
      input.mode === 'standard' || input.mode === 'extension',
      'Choose standard or extension mode.',
    );
    const capacity = integer(input.capacity, 6);
    assert(
      input.mode === 'standard' ? capacity >= 3 && capacity <= 4 : capacity >= 5 && capacity <= 6,
      'Standard supports 3–4 players; extension supports 5–6.',
    );
    const token = randomBytes(32).toString('hex');
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = [...randomBytes(6)].map((byte) => alphabet[byte % alphabet.length]).join('');
      const now = Date.now();
      const room: OnlineRoom = {
        code,
        mode: input.mode,
        capacity,
        host: 0,
        players: [
          {
            id: 0,
            name,
            tokenHash: digest(token),
            connectionHash: digest(connection),
            leaseUntil: now + LEASE,
          },
        ],
        game: null,
        pendingTrade: null,
        revision: 1,
        updatedAt: now,
      };
      const created = await this.firestore.runTransaction(async (tx) => {
        const ref = this.rooms.doc(code);
        if ((await tx.get(ref)).exists) return false;
        tx.create(ref, encodeRoom(room));
        return true;
      });
      if (created)
        return {
          ok: true,
          state: onlineSnapshot(room, 0, now),
          session: { code, token, player: 0 },
        };
    }
    throw new OnlineError('Could not reserve a room code. Please try again.', 503);
  }
  async join(
    code: string,
    input: Record<string, unknown>,
    connection: string,
  ): Promise<OnlineReply> {
    const name = playerName(input.name);
    const token = randomBytes(32).toString('hex');
    return this.change(code, (room) => {
      assert(!room.game, 'This game has started. Use your saved session to reconnect.');
      assert(room.players.length < room.capacity, 'This room is full.');
      assert(
        !room.players.some((p) => p.connectionHash === digest(connection)),
        'You have already joined this room.',
      );
      const id = room.players.length;
      room.players.push({
        id,
        name,
        tokenHash: digest(token),
        connectionHash: digest(connection),
        leaseUntil: Date.now() + LEASE,
      });
      return { player: id, session: { code, token, player: id } };
    });
  }
  async resume(code: string, identity: Identity): Promise<OnlineReply> {
    return this.change(code, (room) => {
      const seat = seatFor(room, identity, true);
      seat.connectionHash = digest(identity.connection);
      seat.leaseUntil = Date.now() + LEASE;
      return { player: seat.id, session: { code, token: identity.token, player: seat.id } };
    });
  }
  async read(code: string, identity: Identity): Promise<OnlineReply> {
    const now = Date.now();
    const room = readRoom((await this.rooms.doc(code).get()).data(), now);
    const seat = seatFor(room, identity);
    if (seat.leaseUntil > now + LEASE - HEARTBEAT)
      return { ok: true, state: onlineSnapshot(room, seat.id, now) };
    // Presence writes run only once per 30 seconds per seat; frequent polls are read-only.
    return this.change(
      code,
      (latest) => {
        const current = seatFor(latest, identity);
        current.leaseUntil = Date.now() + LEASE;
        return { player: current.id };
      },
      false,
    );
  }
  async command(
    code: string,
    identity: Identity,
    event: string,
    input: Record<string, unknown>,
  ): Promise<OnlineReply> {
    return this.change(code, (room) => {
      const seat = seatFor(room, identity);
      if (event === 'disconnect') {
        seat.leaseUntil = 0;
        return { player: seat.id };
      }
      assert(Number.isSafeInteger(input.revision), 'Refresh the room before making a move.');
      if (input.revision !== room.revision)
        throw new OnlineError(
          'The room changed. The latest position will load; please try your move again.',
          412,
        );
      seat.leaseUntil = Date.now() + LEASE;
      const game = room.game;
      switch (event) {
        case 'start': {
          assert(seat.id === room.host, 'Only the host can start the game.');
          assert(!game, 'The game has already started.');
          assert(
            room.players.length === room.capacity,
            `Waiting for all ${room.capacity} players to join.`,
          );
          assert(
            room.players.every((p) => p.leaseUntil > Date.now()),
            'Waiting for every player to reconnect.',
          );
          room.game = createGame({
            mode: room.mode,
            names: room.players.map((p) => p.name),
            seed: randomBytes(16).toString('hex'),
            targetPoints: 10,
          });
          for (let i = room.game.deck.length - 1; i > 0; i--) {
            const j = randomInt(i + 1);
            [room.game.deck[i], room.game.deck[j]] = [room.game.deck[j], room.game.deck[i]];
          }
          room.game.rng = randomRng();
          break;
        }
        case 'action': {
          assert(game, 'The game has not started.');
          const action = parseAction(input.action);
          assert(
            action.type === 'DISCARD' ? action.player === seat.id : game.currentPlayer === seat.id,
            'It is not your turn.',
          );
          try {
            room.game = applyAction({ ...game, rng: randomRng() }, action);
          } catch (error) {
            throw new OnlineError(
              error instanceof Error ? error.message : 'That move is not legal.',
            );
          }
          room.pendingTrade = null;
          break;
        }
        case 'trade-propose': {
          assert(
            game && game.phase === 'action' && game.currentPlayer === seat.id,
            'Offer a trade during your action phase.',
          );
          assert(!game.paired, 'The paired player cannot trade with other players.');
          assert(game.freeRoads === 0, 'Finish placing your free roads before trading.');
          const to = integer(input.player, room.capacity - 1);
          assert(to !== seat.id && room.players[to], 'Choose another player to trade with.');
          assert(room.players[to].leaseUntil > Date.now(), 'That player is disconnected.');
          const give = resources(input.give),
            receive = resources(input.receive);
          assert(
            total(give) > 0 && total(receive) > 0,
            'Offer at least one resource in each direction.',
          );
          assert(
            RESOURCE_NAMES.every((key) => !(give[key] && receive[key])),
            'A trade cannot exchange the same resource in both directions.',
          );
          assert(
            RESOURCE_NAMES.every((key) => game.players[seat.id].resources[key] >= give[key]),
            'You do not have the resources you offered.',
          );
          room.pendingTrade = {
            id: randomBytes(12).toString('hex'),
            from: seat.id,
            to,
            give,
            receive,
            expiresAt: Date.now() + 90_000,
          };
          break;
        }
        case 'trade-accept': {
          const offer = room.pendingTrade;
          assert(
            offer && input.id === offer.id && offer.expiresAt > Date.now(),
            'That trade offer has expired.',
          );
          assert(offer.to === seat.id, 'Only the invited player can accept this offer.');
          assert(
            game && game.currentPlayer === offer.from && game.phase === 'action',
            'That trade is no longer available.',
          );
          try {
            room.game = applyAction(game, {
              type: 'PLAYER_TRADE',
              player: offer.to,
              give: offer.give,
              receive: offer.receive,
            });
          } catch (error) {
            throw new OnlineError(
              error instanceof Error ? error.message : 'That trade is not legal.',
            );
          }
          room.pendingTrade = null;
          break;
        }
        case 'trade-reject': {
          const offer = room.pendingTrade;
          assert(offer && offer.id === input.id, 'That trade offer is no longer available.');
          assert(
            offer.to === seat.id || offer.from === seat.id,
            'Only the trading players can decline this offer.',
          );
          room.pendingTrade = null;
          break;
        }
        default:
          throw new OnlineError('Unknown room request.', 404);
      }
      return { player: seat.id };
    });
  }
  private async change(
    code: string,
    work: (room: OnlineRoom) => { player: number; session?: Session },
    advanceRevision = true,
  ): Promise<OnlineReply> {
    return this.firestore.runTransaction(async (tx) => {
      const ref = this.rooms.doc(code);
      const room = readRoom((await tx.get(ref)).data(), Date.now());
      const result = work(room);
      if (advanceRevision) room.revision++;
      room.updatedAt = Date.now();
      tx.set(ref, encodeRoom(room));
      return {
        ok: true,
        state: onlineSnapshot(room, result.player),
        ...(result.session ? { session: result.session } : {}),
      };
    });
  }
}

function connectionId(req: Request): string {
  const id = req.get('X-Catan-Connection');
  assert(
    typeof id === 'string' && /^[a-zA-Z0-9_-]{20,80}$/.test(id),
    'Invalid room connection. Refresh the page.',
  );
  return id;
}
function identity(req: Request): Identity {
  const token = req.get('Authorization')?.replace(/^Bearer /, '');
  if (!token || !/^[a-f0-9]{64}$/.test(token))
    throw new OnlineError('Reconnect with your saved game session.', 401);
  return { token, connection: connectionId(req) };
}
/** Mount at /api/online. Missing credentials make only online rooms unavailable. */
export function onlineRouter(options: { store?: FirestoreOnlineRooms } = {}) {
  const router = express.Router();
  let store: FirestoreOnlineRooms | undefined = options.store;
  function configured(): FirestoreOnlineRooms {
    if (store) return store;
    try {
      const connection = createRankingsFirestore();
      store = new FirestoreOnlineRooms(connection.firestore, connection.documentPath);
      return store;
    } catch {
      throw new OnlineError(
        'Online rooms are unavailable until the server Firebase environment variables are configured.',
        503,
      );
    }
  }
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Vary', 'Authorization, X-Catan-Connection');
    next();
  });
  router.use((req, _res, next) => {
    if (req.method !== 'GET') {
      const origin = req.get('origin');
      try {
        const url = new URL(origin ?? '');
        const local =
          process.env.NODE_ENV !== 'production' &&
          /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(url.host);
        if (
          (url.host !== req.get('host') && !local) ||
          (process.env.NODE_ENV === 'production' && url.protocol !== 'https:')
        )
          throw new Error();
      } catch {
        return next(new OnlineError('This request must come from the game website.', 403));
      }
    }
    next();
  });
  router.use(express.json({ limit: '12kb' }));
  router.get('/health', (_req, res) => {
    configured();
    res.json({ ok: true });
  });
  router.get('/rooms/:code', async (req, res) => {
    const code = roomCode(req.params.code);
    const auth = identity(req);
    res.json(await configured().read(code, auth));
  });
  router.post('/create', async (req, res) => {
    const input = object(req.body),
      connection = connectionId(req),
      rooms = configured();
    await rooms.rateLimit(req.ip ?? req.socket.remoteAddress ?? 'unknown', true);
    res.json(await rooms.create(input, connection));
  });
  router.post('/join', async (req, res) => {
    const input = object(req.body),
      connection = connectionId(req),
      code = roomCode(input.code),
      rooms = configured();
    await rooms.rateLimit(req.ip ?? req.socket.remoteAddress ?? 'unknown', false);
    res.json(await rooms.join(code, input, connection));
  });
  router.post('/resume', async (req, res) => {
    const input = object(req.body),
      code = roomCode(input.code),
      auth = identity(req),
      rooms = configured();
    await rooms.rateLimit(req.ip ?? req.socket.remoteAddress ?? 'unknown', false);
    res.json(await rooms.resume(code, auth));
  });
  router.post('/rooms/:code/:event', async (req, res) => {
    const input = object(req.body),
      code = roomCode(req.params.code),
      auth = identity(req),
      rooms = configured();
    await rooms.rateLimit(req.ip ?? req.socket.remoteAddress ?? 'unknown', false);
    res.json(await rooms.command(code, auth, String(req.params.event), input));
  });
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof OnlineError)
      return res.status(error.status).json({ ok: false, error: error.message });
    if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large')
      return res.status(413).json({ ok: false, error: 'This room request is too large.' });
    if (error instanceof SyntaxError)
      return res.status(400).json({ ok: false, error: 'Send a valid JSON room request.' });
    res.status(503).json({
      ok: false,
      error:
        'The game server could not confirm this request. Reconnect to check the latest room before trying again.',
    });
  });
  return router;
}
