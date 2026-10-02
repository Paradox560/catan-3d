/** FIRESTORE_EMULATOR_HOST=127.0.0.1:8181 node --import tsx server/online.smoke.ts */
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import type { Server } from 'node:http';
import express from 'express';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { FirestoreOnlineRooms, onlineRouter, type OnlineRoom, type OnlineReply } from './online';
import { legalBuilds } from '../src/game/engine';
import type { RoomSnapshot, Session } from '../src/network';
import type { Resource, Resources } from '../src/game/types';

const emulator = process.env.FIRESTORE_EMULATOR_HOST ?? '';
assert.match(
  emulator,
  /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/,
  'This test requires a local emulator; it never uses a cloud project.',
);
await fetch(`http://${emulator}/`, { signal: AbortSignal.timeout(3000) });
process.env.METADATA_SERVER_DETECTION = 'none';
const app = initializeApp(
  { projectId: 'demo-catan-online' },
  `online-${randomBytes(6).toString('hex')}`,
);
const firestore = getFirestore(app);
firestore.settings({ host: emulator, ssl: false });
const documentPath = `catan/online-test-${randomBytes(8).toString('hex')}`;
const ledger = firestore.doc(documentPath);
const servers: Server[] = [];
async function start() {
  const app = express();
  app.use(
    '/api/online',
    onlineRouter({ store: new FirestoreOnlineRooms(firestore, documentPath) }),
  );
  const server = await new Promise<Server>((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/api/online`;
}
interface Client {
  base: string;
  connection: string;
  session?: Session;
  state?: RoomSnapshot;
}
function client(base: string): Client {
  return { base, connection: randomBytes(24).toString('hex') };
}
async function request(
  c: Client,
  path: string,
  body?: unknown,
  overrides: Record<string, string> = {},
) {
  const response = await fetch(`${c.base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'X-Catan-Connection': c.connection,
      ...(c.session ? { Authorization: `Bearer ${c.session.token}` } : {}),
      ...(body === undefined
        ? {}
        : { 'Content-Type': 'application/json', Origin: new URL(c.base).origin }),
      ...overrides,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = (await response.json()) as OnlineReply & { error?: string };
  if (value.session) c.session = value.session;
  if (value.state) c.state = value.state;
  return { status: response.status, value };
}
async function read(c: Client) {
  const result = await request(c, `/rooms/${c.session!.code}`);
  assert.equal(result.status, 200, JSON.stringify(result.value));
  return c.state!;
}
async function command(c: Client, event: string, input: Record<string, unknown> = {}) {
  await read(c);
  const result = await request(c, `/rooms/${c.session!.code}/${event}`, {
    ...input,
    revision: c.state!.revision,
  });
  assert.equal(result.status, 200, JSON.stringify(result.value));
  return c.state!;
}
const keys: Resource[] = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
const empty = (): Resources => ({ wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 });
try {
  await ledger.set({ unrelated: 'Online rooms must not alter ledger metadata.' });
  const first = await start(),
    second = await start();
  for (const capacity of [3, 4, 5, 6]) {
    const players = Array.from({ length: capacity }, (_, index) =>
      client(index % 2 ? second : first),
    );
    const host = players[0];
    let result = await request(host, '/create', {
      name: 'Host',
      mode: capacity > 4 ? 'extension' : 'standard',
      capacity,
    });
    assert.equal(result.status, 200, JSON.stringify(result.value));
    assert(host.session && host.state);
    for (const [index, player] of players.entries())
      if (index > 0) {
        result = await request(player, '/join', {
          code: host.session.code,
          name: `Player ${index}`,
        });
        assert.equal(result.status, 200, JSON.stringify(result.value));
      }
    result = await request(client(second), '/join', { code: host.session.code, name: 'Overflow' });
    assert.equal(result.status, 400);
    assert.equal((await request(client(first), `/rooms/${host.session.code}`)).status, 401);
    await read(players[1]);
    assert.equal(
      (
        await request(players[1], `/rooms/${host.session.code}/start`, {
          revision: players[1].state!.revision,
        })
      ).status,
      400,
    );
    await command(host, 'start');
    assert.equal(host.state!.game!.players.length, capacity);
    assert.equal(host.state!.game!.board.hexes.length, capacity > 4 ? 30 : 19);
    assert.equal(host.state!.game!.rng, 0);
    assert.equal(host.state!.game!.config.seed, 'online-private');
    assert(host.state!.game!.deck.every((card) => card === 'victory'));
    await read(players[1]);
    assert.equal(
      (
        await request(players[1], `/rooms/${host.session.code}/action`, {
          revision: players[1].state!.revision,
          action: { type: 'ROLL' },
        })
      ).status,
      400,
    );
    if (capacity === 4 || capacity === 6) {
      while (host.state!.game!.phase.startsWith('setup')) {
        const game = host.state!.game!;
        const actor = players[game.currentPlayer];
        const kind = game.phase === 'setupSettlement' ? 'settlement' : 'road';
        const ids = legalBuilds(game, kind);
        assert(ids.length);
        const preferred =
          kind === 'settlement'
            ? ids.sort(
                (a, b) => game.board.vertices[b].hexes.length - game.board.vertices[a].hexes.length,
              )[0]
            : ids[0];
        await command(actor, 'action', { action: { type: 'BUILD', kind, id: preferred } });
        await read(host);
      }
      for (const player of players) {
        const snapshot = await read(player);
        for (const opponent of snapshot.game!.players.filter((p) => p.id !== snapshot.you)) {
          assert.deepEqual(opponent.resources, empty());
          assert.deepEqual(opponent.devCards, []);
          assert(snapshot.resourceCounts[opponent.id] > 0);
        }
        assert.equal(JSON.stringify(snapshot).includes('tokenHash'), false);
        assert.equal(JSON.stringify(snapshot).includes('connectionHash'), false);
      }
      const ref = ledger.collection('onlineRooms').doc(host.session.code);
      const fields = (await ref.get()).data()!;
      const room = JSON.parse(fields.state) as OnlineRoom;
      assert.equal(
        JSON.stringify(fields).includes(host.session.token),
        false,
        'Only a token hash is persisted.',
      );
      // Seed one valid action-phase exchange to make the privacy/consent check deterministic.
      room.game!.phase = 'action';
      room.game!.currentPlayer = 0;
      room.game!.primaryPlayer = 0;
      room.game!.paired = false;
      room.game!.players[0].resources.wood = 2;
      room.game!.players[1].resources.brick = 2;
      await ref.update({ state: JSON.stringify(room) });
      const give = { ...empty(), wood: 1 },
        receive = { ...empty(), brick: 1 };
      await command(host, 'trade-propose', { player: 1, give, receive });
      assert.equal(
        host.state!.game!.players[0].resources.wood,
        2,
        'An offer does not transfer resources.',
      );
      const offerId = host.state!.pendingTrade!.id;
      await read(players[2]);
      assert.equal(
        (
          await request(players[2], `/rooms/${host.session.code}/trade-accept`, {
            id: offerId,
            revision: players[2].state!.revision,
          })
        ).status,
        400,
      );
      await command(players[1], 'trade-accept', { id: offerId });
      await read(host);
      assert.equal(host.state!.game!.players[0].resources.wood, 1);
      assert.equal(host.state!.pendingTrade, null);
      assert.equal(
        (
          await request(host, `/rooms/${host.session.code}/action`, {
            revision: host.state!.revision,
            action: { type: 'PLAYER_TRADE', player: 1, give, receive },
          })
        ).status,
        400,
      );
      const revision = host.state!.revision;
      const simultaneous = await Promise.all([
        request(host, `/rooms/${host.session.code}/action`, {
          revision,
          action: { type: 'END_TURN' },
        }),
        request({ ...host, base: second }, `/rooms/${host.session.code}/action`, {
          revision,
          action: { type: 'END_TURN' },
        }),
      ]);
      assert.deepEqual(
        simultaneous.map((r) => r.status).sort(),
        [200, 412],
        'A stale action cannot be replayed across instances.',
      );
      const takeover = client(second);
      takeover.session = host.session;
      result = await request(takeover, '/resume', { code: host.session.code });
      assert.equal(result.status, 200);
      assert.equal((await request(host, `/rooms/${host.session.code}`)).status, 409);
      assert.equal(
        (
          await request(host, `/rooms/${host.session.code}/action`, {
            revision: takeover.state!.revision,
            action: { type: 'ROLL' },
          })
        ).status,
        409,
      );
      const third = await start();
      takeover.base = third;
      assert.equal(
        (await read(takeover)).game!.turn,
        result.value.state.game!.turn,
        'A new router instance reads the same persisted room.',
      );
      const stateBefore = (await ref.get()).data()!.state;
      assert.equal(
        (
          await request(takeover, `/rooms/${host.session.code}/action`, {
            extra: 'x'.repeat(13_000),
          })
        ).status,
        413,
      );
      assert.equal(
        (
          await request(
            takeover,
            `/rooms/${host.session.code}/disconnect`,
            {},
            { Origin: 'https://untrusted.example' },
          )
        ).status,
        403,
      );
      assert.equal((await ref.get()).data()!.state, stateBefore);
      await request(takeover, `/rooms/${host.session.code}/disconnect`, {});
      assert.equal((await read(players[1])).players[0].connected, false);
      await read(takeover);
      assert.equal(
        (await read(players[1])).players[0].connected,
        true,
        'Polling renews an expired presence lease without taking over another session.',
      );
    }
    console.info(
      `PASS HTTP ${capacity}-player room, shared Firestore state, ownership, and mode validation.`,
    );
  }
  assert.deepEqual((await ledger.get()).data(), {
    unrelated: 'Online rooms must not alter ledger metadata.',
  });
  const address = 'separate-test-client';
  const ref = ledger
    .collection('onlineLimits')
    .doc(`write-${createHash('sha256').update(address).digest('hex')}`);
  await ref.set({ count: 239, reset: Date.now() + 60_000 });
  const stores = [
    new FirestoreOnlineRooms(firestore, documentPath),
    new FirestoreOnlineRooms(firestore, documentPath),
  ];
  const limits = await Promise.allSettled(stores.map((store) => store.rateLimit(address, false)));
  assert.equal(
    limits.filter((r) => r.status === 'fulfilled').length,
    1,
    'Write limits are shared across instances.',
  );
  console.info(
    'PASS HTTP privacy, trade consent, concurrent revisions, session takeover, persistent instances, origins, request bounds, and shared rate limits.',
  );
} finally {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
  await firestore.recursiveDelete(ledger);
  await firestore.terminate();
  await deleteApp(app);
}
