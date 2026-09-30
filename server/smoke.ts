/** Real Socket.IO integration check: npm run test:server (or node --import tsx server/smoke.ts). */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io, type Socket } from 'socket.io-client';
import type { Reply, RoomSnapshot, Session } from '../src/network';
import type { DevType, GameState, Resource, Resources } from '../src/game/types';
import { score } from '../src/game/engine';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'catan-server-test-'));
const port = 41_000 + Math.floor(Math.random() * 8_000);
const url = `http://127.0.0.1:${port}`;
const keys: Resource[] = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
const empty = (): Resources => ({ wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let server: ChildProcess;
let output = '';
const clients: Client[] = [];
interface Client {
  socket: Socket;
  snapshot: RoomSnapshot | null;
  session: Session | null;
}

async function start(): Promise<void> {
  server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), CATAN_DATA_DIR: dataDir, NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', (value) => {
    output += String(value);
  });
  server.stderr?.on('data', (value) => {
    output += String(value);
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) return;
    } catch {}
    if (server.exitCode !== null) throw new Error(`Server exited: ${output}`);
    await pause(50);
  }
  throw new Error(`Server did not start: ${output}`);
}
async function stop(): Promise<void> {
  if (server?.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    server.once('exit', () => resolve());
    server.kill('SIGTERM');
  });
}
async function connect(): Promise<Client> {
  const socket = io(url, { autoConnect: false, reconnection: false, transports: ['websocket'] });
  const client: Client = { socket, snapshot: null, session: null };
  socket.on('room:state', (snapshot) => {
    client.snapshot = snapshot;
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
    socket.connect();
  });
  clients.push(client);
  return client;
}
async function request(client: Client, event: string, payload = {}): Promise<Reply> {
  const reply = await new Promise<Reply>((resolve, reject) => {
    client.socket
      .timeout(3_000)
      .emit(event, payload, (error: Error | null, value: Reply) =>
        error ? reject(error) : resolve(value),
      );
  });
  if (reply.session) client.session = reply.session;
  return reply;
}
async function success(client: Client, event: string, payload = {}): Promise<Reply> {
  const reply = await request(client, event, payload);
  assert.equal(reply.ok, true, `${event}: ${reply.error}`);
  return reply;
}

async function roomTest(capacity: number): Promise<Client[]> {
  const players = await Promise.all(Array.from({ length: capacity }, () => connect()));
  const host = players[0];
  await success(host, 'room:create', {
    name: 'Host',
    mode: capacity > 4 ? 'extension' : 'standard',
    capacity,
  });
  assert.equal(
    (await request(host, 'room:start')).ok,
    false,
    'Host cannot start with empty seats.',
  );
  for (let i = 1; i < players.length; i++)
    await success(players[i], 'room:join', { name: `Player ${i + 1}`, code: host.session!.code });
  assert.equal(
    (await request(players[1], 'room:start')).ok,
    false,
    'A guest cannot start the game.',
  );
  await success(host, 'room:start');
  assert.equal(host.snapshot!.game!.board.hexes.length, capacity > 4 ? 30 : 19);
  assert.equal(
    (
      await request(players[1], 'game:action', {
        action: { type: 'BUILD', kind: 'settlement', id: 0 },
      })
    ).ok,
    false,
    'A guest cannot act as another seat.',
  );
  assert.equal(
    (
      await request(host, 'game:action', {
        action: { type: 'PLAYER_TRADE', player: 1, give: empty(), receive: empty() },
      })
    ).ok,
    false,
    'Raw player trades are forbidden.',
  );
  while (host.snapshot!.game!.phase.startsWith('setup')) {
    const game = host.snapshot!.game!;
    const player = players[game.currentPlayer];
    if (game.phase === 'setupSettlement') {
      const available = game.board.vertices.filter(
        (vertex) =>
          !vertex.building &&
          vertex.edges.every((id) => {
            const edge = game.board.edges[id];
            return !game.board.vertices[edge.a === vertex.id ? edge.b : edge.a].building;
          }),
      );
      available.sort((a, b) => b.hexes.length - a.hexes.length);
      assert(available.length, 'A legal settlement exists.');
      await success(player, 'game:action', {
        action: { type: 'BUILD', kind: 'settlement', id: available[0].id },
      });
    } else {
      const vertex = game.board.vertices[game.setupVertex!];
      const edge = vertex.edges.find((id) => game.board.edges[id].owner === null);
      await success(player, 'game:action', { action: { type: 'BUILD', kind: 'road', id: edge } });
    }
  }
  for (const player of players) {
    const state = player.snapshot!;
    assert.equal(state.game!.rng, 0);
    assert.equal(state.game!.config.seed, 'online-private');
    assert(
      state.game!.deck.every((card) => card === 'victory'),
      'The shuffled deck is private.',
    );
    for (const opponent of state.game!.players.filter((p) => p.id !== state.you)) {
      assert.equal(
        keys.reduce((sum, key) => sum + opponent.resources[key], 0),
        0,
        'Opponent resources are hidden.',
      );
      assert.equal(opponent.devCards.length, 0, 'Opponent development cards are hidden.');
      assert(state.resourceCounts[opponent.id] > 0, 'Public resource totals are available.');
    }
  }
  const active = players[host.snapshot!.game!.currentPlayer];
  await success(active, 'game:action', { action: { type: 'ROLL' } });
  if (active.snapshot!.game!.phase === 'robber') {
    await success(active, 'game:action', {
      action: {
        type: 'MOVE_ROBBER',
        hex: active.snapshot!.game!.board.hexes.find(
          (hex) => hex.id !== active.snapshot!.game!.robberHex,
        )!.id,
      },
    });
    const updated = structuredClone(active.snapshot!);
    if (updated.game!.phase === 'steal')
      await success(active, 'game:action', {
        action: { type: 'STEAL', player: updated.game!.stealTargets[0] },
      });
  }
  assert.equal(active.snapshot!.game!.phase, 'action');
  const own = active.snapshot!.game!.players[active.snapshot!.you];
  const fromResource = keys.find((key) => own.resources[key] > 0)!;
  const recipient = players.find(
    (other) =>
      other !== active &&
      keys.some(
        (key) =>
          key !== fromResource &&
          other.snapshot!.game!.players[other.snapshot!.you].resources[key] > 0,
      ),
  );
  assert(recipient, 'There is a resource trade available.');
  const toResource = keys.find(
    (key) =>
      key !== fromResource &&
      recipient.snapshot!.game!.players[recipient.snapshot!.you].resources[key] > 0,
  )!;
  const give = empty(),
    receive = empty();
  give[fromResource] = 1;
  receive[toResource] = 1;
  const before = structuredClone(own.resources);
  await success(active, 'trade:propose', { player: recipient.snapshot!.you, give, receive });
  assert.deepEqual(
    active.snapshot!.game!.players[active.snapshot!.you].resources,
    before,
    'Offering a trade does not exchange resources.',
  );
  const id = active.snapshot!.pendingTrade!.id;
  const outsider = players.find((player) => player !== recipient && player !== active)!;
  assert.equal(
    (await request(outsider, 'trade:accept', { id })).ok,
    false,
    'Only the requested recipient can consent.',
  );
  await success(recipient, 'trade:accept', { id });
  assert.equal(
    active.snapshot!.game!.players[active.snapshot!.you].resources[fromResource],
    before[fromResource] - 1,
  );
  assert.equal(
    active.snapshot!.game!.players[active.snapshot!.you].resources[toResource],
    before[toResource] + 1,
  );
  assert.equal(
    (await request(recipient, 'trade:accept', { id })).ok,
    false,
    'Accepted offers cannot be replayed.',
  );
  console.log(`PASS ${capacity}-player room: setup, hidden hands, turn ownership, trade consent.`);
  return players;
}

async function victoryRevealTest(sessions: Session[]): Promise<void> {
  // Seed a reachable late-game position through the existing persistence boundary,
  // then exercise the real winning action and per-seat Socket.IO snapshots.
  for (const client of clients) client.socket.disconnect();
  await stop();
  const savePath = path.join(dataDir, 'rooms.json');
  const savedRooms = JSON.parse(readFileSync(savePath, 'utf8')) as {
    code: string;
    game: GameState;
    players: { tokenHash: string }[];
  }[];
  const room = savedRooms.find((saved) => saved.code === sessions[0].code)!;
  const game = room.game;
  const winner = game.players[0];
  game.config.seed = 'private-victory-fixture-seed';
  game.rng = 0xfedcba98;
  game.currentPlayer = 0;
  game.primaryPlayer = 0;
  game.paired = false;
  game.turn = 18;
  game.round = 7;
  game.phase = 'action';
  game.winner = null;
  game.freeRoads = 0;
  game.devPlayed = false;
  game.largestArmy = 0;
  winner.knights = 3;
  for (const vertex of game.board.vertices) {
    if (vertex.building?.owner === 0) vertex.building.type = 'city';
  }
  function removeCard(type: DevType): DevType {
    const index = game.deck.indexOf(type);
    assert(index >= 0, `Fixture needs another ${type} card.`);
    return game.deck.splice(index, 1)[0];
  }
  winner.devCards = [0, 1, 2].map((id) => ({ id, type: removeCard('victory'), boughtTurn: 0 }));
  game.players[1].devCards = [{ id: 3, type: removeCard('knight'), boughtTurn: 0 }];
  for (let i = 0; i < 3; i++) removeCard('knight'); // Already played for Largest Army.
  game.deck.push(removeCard('victory')); // The next legitimate purchase wins the game.
  const privateResources: Resources = { wood: 2, brick: 1, sheep: 1, wheat: 1, ore: 1 };
  for (const key of keys) game.bank[key] += winner.resources[key] - privateResources[key];
  winner.resources = privateResources;
  assert.equal(score(game, 0), 9, 'The fixture starts one point short of victory.');
  assert.equal(score(game, 0, false), 6, 'Three victory points begin hidden.');
  const secrets = [
    ...sessions.map((session) => session.token),
    ...room.players.map((player) => player.tokenHash),
    game.config.seed,
  ];
  writeFileSync(savePath, JSON.stringify(savedRooms), { mode: 0o600 });
  await start();
  const players = await Promise.all(sessions.map(() => connect()));
  for (let i = 0; i < players.length; i++) await success(players[i], 'room:resume', sessions[i]);

  function assertPrivateSnapshot(state: RoomSnapshot): void {
    assert.equal(state.game!.rng, 0, 'RNG state remains hidden, including after victory.');
    assert.equal(state.game!.config.seed, 'online-private', 'The board seed remains hidden.');
    assert(
      state.game!.deck.every((card) => card === 'victory'),
      'Undrawn deck identities remain hidden.',
    );
    assert.deepEqual(
      state.players.map((player) => Object.keys(player).sort()),
      state.players.map(() => ['connected', 'id', 'name']),
      'Room seats never expose token hashes or socket identifiers.',
    );
    const payload = JSON.stringify(state);
    for (const secret of secrets)
      assert(
        !payload.includes(secret),
        'Snapshots never include private tokens, token hashes, or seeds.',
      );
    for (const opponent of state.game!.players.filter((player) => player.id !== state.you)) {
      assert.deepEqual(
        opponent.resources,
        empty(),
        'Resource identities remain private after victory.',
      );
    }
  }
  for (const player of players) {
    const state = player.snapshot!;
    assertPrivateSnapshot(state);
    assert.equal(state.game!.phase, 'action');
    assert.equal(state.devCounts[0], 3, 'Observers see the correct public development-card total.');
    assert.equal(state.devCounts[1], 1);
    for (const opponent of state.game!.players.filter((candidate) => candidate.id !== state.you)) {
      assert.deepEqual(
        opponent.devCards,
        [],
        'Real opponent development cards are hidden before victory.',
      );
    }
  }
  assert.equal(
    score(players[1].snapshot!.game!, 0),
    6,
    'An observer cannot score the hidden victory cards before the game ends.',
  );
  await success(players[0], 'game:action', { action: { type: 'BUY_DEV' } });
  for (const player of players) {
    const state = player.snapshot!;
    assertPrivateSnapshot(state);
    assert.equal(state.game!.phase, 'gameOver');
    assert.equal(state.game!.winner, 0);
    assert.equal(
      score(state.game!, 0),
      10,
      'Every player sees the full winning score including formerly secret victory points.',
    );
    assert.equal(
      state.game!.players[0].devCards.filter((card) => card.type === 'victory').length,
      4,
    );
    assert.equal(
      state.game!.players[1].devCards[0]?.type,
      'knight',
      'All development-card identities reveal only after the game ends.',
    );
    assert.equal(
      state.resourceCounts[0],
      3,
      'The winner retains private resource cards; only their total is public.',
    );
  }
  console.log(
    'PASS game-over reveal: hidden development cards become scoreable; resources, RNG, deck, and tokens stay private.',
  );
}

try {
  await start();
  const crossOrigin = io(url, {
    reconnection: false,
    transports: ['websocket'],
    extraHeaders: { Origin: 'https://untrusted.example' },
  });
  await new Promise<void>((resolve, reject) => {
    crossOrigin.once('connect_error', () => resolve());
    crossOrigin.once('connect', () => reject(new Error('Untrusted origins must be refused.')));
  });
  crossOrigin.disconnect();
  const invalid = await connect();
  assert.equal(
    (await request(invalid, 'room:create', { name: 'Invalid', mode: 'standard', capacity: 6 })).ok,
    false,
  );
  const standard = await roomTest(3);
  await roomTest(6);
  const resumeSession = standard[0].session!;
  const originalGame = structuredClone(standard[0].snapshot!.game);
  const save = readFileSync(path.join(dataDir, 'rooms.json'), 'utf8');
  assert(!save.includes(resumeSession.token), 'Reconnect tokens are hashed on disk.');
  for (const client of clients) client.socket.disconnect();
  await stop();
  await start();
  const resumed = await connect();
  assert.equal(
    (await request(resumed, 'room:resume', { code: resumeSession.code, token: 'f'.repeat(64) })).ok,
    false,
    'Invalid reconnect tokens are refused.',
  );
  await success(resumed, 'room:resume', resumeSession);
  assert.deepEqual(resumed.snapshot!.game, originalGame, 'Restart preserves the complete game.');
  assert.equal(resumed.snapshot!.you, resumeSession.player);
  const takeover = await connect();
  const displaced = new Promise<void>((resolve) => {
    resumed.socket.once('disconnect', () => resolve());
  });
  await success(takeover, 'room:resume', resumeSession);
  await displaced;
  assert.equal(resumed.socket.connected, false, 'Only one connection can control a seat.');
  assert.equal(takeover.snapshot!.you, resumeSession.player);
  console.log('PASS restart persistence, token hashing, and authenticated reconnection.');
  await victoryRevealTest(standard.map((client) => client.session!));
} catch (error) {
  console.error(output);
  throw error;
} finally {
  for (const client of clients) client.socket.disconnect();
  await stop();
  rmSync(dataDir, { recursive: true, force: true });
}
