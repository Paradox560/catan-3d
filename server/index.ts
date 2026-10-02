import express from 'express';
import { rankingsRouter } from './rankings';
import { createServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { randomBytes, randomInt, createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGame, applyAction } from '../src/game/engine';
import type { GameAction, GameState, Resource, Resources } from '../src/game/types';
import type { PendingTrade, Reply, RoomSnapshot } from '../src/network';

interface Seat {
  id: number;
  name: string;
  tokenHash: string;
  socketId: string | null;
}
interface Room {
  code: string;
  mode: 'standard' | 'extension';
  capacity: number;
  host: number;
  players: Seat[];
  game: GameState | null;
  pendingTrade: PendingTrade | null;
  updatedAt: number;
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 3001);
const DATA_DIR = process.env.CATAN_DATA_DIR ?? path.join(ROOT, 'server', 'data');
const SAVE_FILE = path.join(DATA_DIR, 'rooms.json');
const TTL = 72 * 60 * 60 * 1000;
const RESOURCE_NAMES: Resource[] = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
const emptyResources = (): Resources => ({ wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 });
const total = (resources: Resources): number =>
  RESOURCE_NAMES.reduce((sum, key) => sum + resources[key], 0);
const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');
const randomRng = (): number => randomBytes(4).readUInt32LE(0) || 1;
const rooms = new Map<string, Room>();

function restore(): void {
  if (!existsSync(SAVE_FILE)) return;
  try {
    const saved: unknown = JSON.parse(readFileSync(SAVE_FILE, 'utf8'));
    if (!Array.isArray(saved)) throw new Error('Room save is not an array.');
    for (const value of saved) {
      const room = value as Room;
      if (
        !room ||
        !/^[A-Z2-9]{6}$/.test(room.code) ||
        !Array.isArray(room.players) ||
        room.players.length > 6 ||
        room.updatedAt < Date.now() - TTL
      )
        continue;
      if (
        !room.players.every(
          (p) => typeof p.tokenHash === 'string' && /^[a-f0-9]{64}$/.test(p.tokenHash),
        )
      )
        continue;
      room.players.forEach((player) => {
        player.socketId = null;
      });
      room.pendingTrade = null;
      rooms.set(room.code, room);
    }
    console.info(`Restored ${rooms.size} Catan room(s).`);
  } catch (error) {
    console.error('Could not restore room saves:', error);
  }
}
function persist(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(
      `${SAVE_FILE}.tmp`,
      JSON.stringify(
        [...rooms.values()].map((room) => ({
          ...room,
          players: room.players.map((player) => ({ ...player, socketId: null })),
          pendingTrade: null,
        })),
      ),
      { mode: 0o600 },
    );
    renameSync(`${SAVE_FILE}.tmp`, SAVE_FILE);
  } catch (error) {
    console.error('Could not persist room saves:', error);
  }
}
restore();

const app = express();
app.disable('x-powered-by');
app.use('/api/rankings', rankingsRouter(DATA_DIR));
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'catan-3d', rooms: rooms.size });
});
const http = createServer(app);
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const io = new Server(http, {
  maxHttpBufferSize: 12_000,
  cors: allowedOrigins.length ? { origin: allowedOrigins, methods: ['GET', 'POST'] } : undefined,
  allowRequest: (req, done) => {
    const origin = req.headers.origin;
    if (!origin) return done(null, true); // Native clients and health/test clients.
    try {
      const host = new URL(origin).host;
      const requestHost = req.headers.host;
      const development =
        process.env.NODE_ENV !== 'production' && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
      done(null, host === requestHost || development || allowedOrigins.includes(origin));
    } catch {
      done(null, false);
    }
  },
});

function snapshot(room: Room, player: number): RoomSnapshot {
  const game = room.game ? structuredClone(room.game) : null;
  const resourceCounts: Record<number, number> = {};
  const devCounts: Record<number, number> = {};
  if (game) {
    game.players.forEach((p) => {
      resourceCounts[p.id] = total(p.resources);
      devCounts[p.id] = p.devCards.length;
      if (p.id !== player) {
        p.resources = emptyResources();
        if (game.phase !== 'gameOver') p.devCards = [];
      }
    });
    // Only the size of the deck is public. Keep the GameState shape for board/UI helpers.
    game.deck = game.deck.map(() => 'victory');
    game.rng = 0;
    game.config.seed = 'online-private';
  }
  return {
    code: room.code,
    mode: room.mode,
    capacity: room.capacity,
    host: room.host,
    players: room.players.map((p) => ({ id: p.id, name: p.name, connected: !!p.socketId })),
    game,
    you: player,
    resourceCounts,
    devCounts,
    pendingTrade: room.pendingTrade,
  };
}
function broadcast(room: Room): void {
  room.players.forEach((player) => {
    if (player.socketId) io.to(player.socketId).emit('room:state', snapshot(room, player.id));
  });
}
function saveAndBroadcast(room: Room): void {
  room.updatedAt = Date.now();
  persist();
  broadcast(room);
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'Invalid request.');
  return value as Record<string, unknown>;
}
function integer(value: unknown, maximum = 500): number {
  assert(
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= maximum,
    'Invalid number.',
  );
  return value;
}
function name(value: unknown): string {
  assert(typeof value === 'string', 'Enter your player name.');
  const result = value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 24);
  assert(result.length > 0, 'Enter your player name.');
  return result;
}
function roomCode(value: unknown): string {
  assert(typeof value === 'string', 'Enter the six-character room code.');
  const code = value.trim().toUpperCase();
  assert(/^[A-Z2-9]{6}$/.test(code), 'Enter a valid six-character room code.');
  return code;
}
function resource(value: unknown): Resource {
  assert(RESOURCE_NAMES.includes(value as Resource), 'Invalid resource.');
  return value as Resource;
}
function resources(value: unknown): Resources {
  const input = object(value);
  const output = emptyResources();
  for (const key of RESOURCE_NAMES) output[key] = integer(input[key], 100);
  assert(
    Object.keys(input).every((key) => RESOURCE_NAMES.includes(key as Resource)),
    'Invalid resource selection.',
  );
  return output;
}
function parseAction(value: unknown): GameAction {
  const action = object(value);
  switch (action.type) {
    case 'ROLL':
    case 'END_TURN':
    case 'BUY_DEV':
    case 'SKIP_FREE_ROADS':
      return { type: action.type };
    case 'BUILD':
      assert(['road', 'settlement', 'city'].includes(action.kind as string), 'Invalid building.');
      return {
        type: 'BUILD',
        kind: action.kind as 'road' | 'settlement' | 'city',
        id: integer(action.id),
      };
    case 'DISCARD':
      return {
        type: 'DISCARD',
        player: integer(action.player, 5),
        resources: resources(action.resources),
      };
    case 'MOVE_ROBBER':
      return { type: 'MOVE_ROBBER', hex: integer(action.hex, 50) };
    case 'STEAL':
      return { type: 'STEAL', player: integer(action.player, 5) };
    case 'BANK_TRADE':
      return { type: 'BANK_TRADE', give: resource(action.give), receive: resource(action.receive) };
    case 'PLAY_DEV': {
      const result: GameAction = { type: 'PLAY_DEV', card: integer(action.card, 1_000) };
      if (action.resources !== undefined) {
        assert(
          Array.isArray(action.resources) && action.resources.length <= 2,
          'Choose up to two resources.',
        );
        result.resources = action.resources.map(resource);
      }
      if (action.resource !== undefined) result.resource = resource(action.resource);
      return result;
    }
    case 'PLAYER_TRADE':
      throw new Error('Player trades require the other player to accept the offer.');
    default:
      throw new Error('Unknown game action.');
  }
}
function makeCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = [...randomBytes(6)].map((byte) => alphabet[byte % alphabet.length]).join('');
  } while (rooms.has(code));
  return code;
}
function locate(socket: Socket): { room: Room; seat: Seat } {
  const room = rooms.get(socket.data.code);
  assert(room, 'Join a room first.');
  const seat = room.players.find(
    (player) => player.id === socket.data.player && player.socketId === socket.id,
  );
  assert(seat, 'Your seat is not connected. Rejoin with your saved session.');
  return { room, seat };
}
function attach(socket: Socket, room: Room, seat: Seat): void {
  if (socket.data.code && (socket.data.code !== room.code || socket.data.player !== seat.id)) {
    const previous = rooms.get(socket.data.code);
    const oldSeat = previous?.players.find((player) => player.socketId === socket.id);
    if (oldSeat && previous) {
      oldSeat.socketId = null;
      broadcast(previous);
    }
  }
  if (seat.socketId && seat.socketId !== socket.id) {
    const previousSocket = io.sockets.sockets.get(seat.socketId);
    previousSocket?.emit('session:replaced');
    previousSocket?.disconnect(true);
  }
  seat.socketId = socket.id;
  socket.data.code = room.code;
  socket.data.player = seat.id;
}
const createLimits = new Map<string, { count: number; reset: number }>();
io.on('connection', (socket) => {
  let windowStart = Date.now();
  let requests = 0;
  function handle(event: string, work: (payload: Record<string, unknown>) => Reply | void): void {
    socket.on(event, (payload: unknown, acknowledgement: unknown) => {
      const ack =
        typeof acknowledgement === 'function'
          ? (acknowledgement as (reply: Reply) => void)
          : () => {};
      try {
        if (Date.now() - windowStart > 1_000) {
          windowStart = Date.now();
          requests = 0;
        }
        assert(++requests <= 20, 'Please slow down and try again.');
        ack(work(object(payload ?? {})) ?? { ok: true });
      } catch (error) {
        ack({ ok: false, error: error instanceof Error ? error.message : 'The request failed.' });
      }
    });
  }
  handle('room:create', (payload) => {
    assert(rooms.size < 1_000, 'The server is full. Please try again later.');
    const ip = socket.handshake.address;
    const limit = createLimits.get(ip);
    const current =
      !limit || limit.reset < Date.now()
        ? { count: 0, reset: Date.now() + 60 * 60 * 1_000 }
        : limit;
    assert(
      current.count < 20,
      'Too many rooms created. Please join an existing room or try again later.',
    );
    const playerName = name(payload.name);
    assert(
      payload.mode === 'standard' || payload.mode === 'extension',
      'Choose standard or extension mode.',
    );
    const capacity = integer(payload.capacity, 6);
    assert(
      payload.mode === 'standard' ? capacity >= 3 && capacity <= 4 : capacity >= 5 && capacity <= 6,
      'Standard supports 3–4 players; extension supports 5–6.',
    );
    current.count++;
    createLimits.set(ip, current);
    const token = randomBytes(32).toString('hex');
    const room: Room = {
      code: makeCode(),
      mode: payload.mode,
      capacity,
      host: 0,
      players: [{ id: 0, name: playerName, tokenHash: tokenHash(token), socketId: null }],
      game: null,
      pendingTrade: null,
      updatedAt: Date.now(),
    };
    rooms.set(room.code, room);
    attach(socket, room, room.players[0]);
    saveAndBroadcast(room);
    return { ok: true, session: { code: room.code, token, player: 0 } };
  });
  handle('room:join', (payload) => {
    const code = roomCode(payload.code);
    const playerName = name(payload.name);
    const room = rooms.get(code);
    assert(room, 'Room not found. Check the code with your host.');
    assert(
      !room.game,
      'This game has started. Use the browser where you originally joined to reconnect.',
    );
    assert(room.players.length < room.capacity, 'This room is full.');
    assert(
      !room.players.some((player) => player.socketId === socket.id),
      'You have already joined this room.',
    );
    const token = randomBytes(32).toString('hex');
    const seat: Seat = {
      id: room.players.length,
      name: playerName,
      tokenHash: tokenHash(token),
      socketId: null,
    };
    room.players.push(seat);
    attach(socket, room, seat);
    saveAndBroadcast(room);
    return { ok: true, session: { code, token, player: seat.id } };
  });
  handle('room:resume', (payload) => {
    const code = roomCode(payload.code);
    assert(
      typeof payload.token === 'string' && /^[a-f0-9]{64}$/.test(payload.token),
      'Invalid reconnect token.',
    );
    const room = rooms.get(code);
    assert(room, 'This room has expired. Create or join a new game.');
    const digest = Buffer.from(tokenHash(payload.token), 'hex');
    const seat = room.players.find((player) =>
      timingSafeEqual(Buffer.from(player.tokenHash, 'hex'), digest),
    );
    assert(seat, 'The saved session does not belong to this room.');
    attach(socket, room, seat);
    saveAndBroadcast(room);
    return { ok: true, session: { code, token: payload.token, player: seat.id } };
  });
  handle('room:start', () => {
    const { room, seat } = locate(socket);
    assert(seat.id === room.host, 'Only the host can start the game.');
    assert(!room.game, 'The game has already started.');
    assert(
      room.players.length === room.capacity,
      `Waiting for all ${room.capacity} players to join.`,
    );
    assert(
      room.players.every((player) => player.socketId),
      'Waiting for every player to reconnect.',
    );
    room.game = createGame({
      mode: room.mode,
      names: room.players.map((player) => player.name),
      seed: randomBytes(16).toString('hex'),
      targetPoints: 10,
    });
    // Board generation uses a replayable PRNG; never let that expose the development deck.
    for (let i = room.game.deck.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [room.game.deck[i], room.game.deck[j]] = [room.game.deck[j], room.game.deck[i]];
    }
    room.game.rng = randomRng();
    saveAndBroadcast(room);
  });
  handle('game:action', (payload) => {
    const { room, seat } = locate(socket);
    assert(room.game, 'The game has not started.');
    const action = parseAction(payload.action);
    assert(
      action.type === 'DISCARD' ? action.player === seat.id : room.game.currentPlayer === seat.id,
      'It is not your turn.',
    );
    room.game = applyAction({ ...room.game, rng: randomRng() }, action);
    room.pendingTrade = null;
    saveAndBroadcast(room);
  });
  handle('trade:propose', (payload) => {
    const { room, seat } = locate(socket);
    const game = room.game;
    assert(
      game && game.phase === 'action' && game.currentPlayer === seat.id,
      'Offer a trade during your action phase.',
    );
    assert(!game.paired, 'The paired player cannot trade with other players.');
    assert(game.freeRoads === 0, 'Finish placing your free roads before trading.');
    const to = integer(payload.player, room.capacity - 1);
    assert(to !== seat.id && room.players[to], 'Choose another player to trade with.');
    assert(room.players[to].socketId, 'That player is disconnected.');
    const give = resources(payload.give);
    const receive = resources(payload.receive);
    assert(total(give) > 0 && total(receive) > 0, 'Offer at least one resource in each direction.');
    assert(
      RESOURCE_NAMES.every((key) => !(give[key] && receive[key])),
      'A trade cannot exchange the same resource in both directions.',
    );
    assert(
      RESOURCE_NAMES.every((key) => game.players[seat.id].resources[key] >= give[key]),
      'You do not have the resources you offered.',
    );
    // Do not reveal whether the recipient owns the requested resources until they choose to accept.
    room.pendingTrade = {
      id: randomBytes(12).toString('hex'),
      from: seat.id,
      to,
      give,
      receive,
      expiresAt: Date.now() + 90_000,
    };
    broadcast(room);
  });
  handle('trade:accept', (payload) => {
    const { room, seat } = locate(socket);
    const offer = room.pendingTrade;
    assert(
      offer && payload.id === offer.id && offer.expiresAt > Date.now(),
      'That trade offer has expired.',
    );
    assert(offer.to === seat.id, 'Only the invited player can accept this offer.');
    assert(
      room.game && room.game.currentPlayer === offer.from && room.game.phase === 'action',
      'That trade is no longer available.',
    );
    room.game = applyAction(room.game, {
      type: 'PLAYER_TRADE',
      player: offer.to,
      give: offer.give,
      receive: offer.receive,
    });
    room.pendingTrade = null;
    saveAndBroadcast(room);
  });
  handle('trade:reject', (payload) => {
    const { room, seat } = locate(socket);
    const offer = room.pendingTrade;
    assert(offer && offer.id === payload.id, 'That trade offer is no longer available.');
    assert(
      offer.to === seat.id || offer.from === seat.id,
      'Only the trading players can decline this offer.',
    );
    room.pendingTrade = null;
    broadcast(room);
  });
  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.code);
    const seat = room?.players.find((player) => player.socketId === socket.id);
    if (room && seat) {
      seat.socketId = null;
      broadcast(room);
    }
  });
});

const maintenance = setInterval(() => {
  let changed = false;
  for (const [code, room] of rooms) {
    if (room.updatedAt < Date.now() - TTL && room.players.every((player) => !player.socketId)) {
      rooms.delete(code);
      changed = true;
      continue;
    }
    if (room.pendingTrade && room.pendingTrade.expiresAt <= Date.now()) {
      room.pendingTrade = null;
      broadcast(room);
    }
  }
  for (const [ip, limit] of createLimits) if (limit.reset < Date.now()) createLimits.delete(ip);
  if (changed) persist();
}, 15_000);
maintenance.unref();

const dist = path.join(ROOT, 'dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get('/{*path}', (_req, res) => {
    res.sendFile(path.join(dist, 'index.html'));
  });
} else
  app.get('/', (_req, res) => {
    res
      .type('text/plain')
      .send(
        'Catan multiplayer server is running. Use npm run dev for the client, or npm run build and restart to serve the production site.',
      );
  });
http.listen(PORT, '0.0.0.0', () =>
  console.info(`Catan server listening on http://localhost:${PORT}`),
);
function shutdown(): void {
  persist();
  io.close();
  http.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
