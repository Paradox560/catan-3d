import { describe, expect, it } from 'vitest';
import {
  applyAction,
  COSTS,
  createGame,
  emptyResources,
  legalBuilds,
  longestRoadLength,
  RESOURCES,
  resourceCount,
  score,
  tradeRate,
} from './engine';
import type { Board, GameAction, GameState, Resources } from './types';

const newGame = (players = 4, seed = 'test-island') =>
  createGame({
    mode: players > 4 ? 'extension' : 'standard',
    names: Array.from({ length: players }, (_, i) => `Player ${i + 1}`),
    seed,
    targetPoints: 10,
  });
function setup(players = 4): GameState {
  let state = newGame(players);
  while (state.phase === 'setupSettlement' || state.phase === 'setupRoad') {
    const kind = state.phase === 'setupSettlement' ? 'settlement' : 'road';
    state = applyAction(state, { type: 'BUILD', kind, id: legalBuilds(state, kind)[0] });
  }
  return state;
}
function grant(state: GameState, player: number, resources: Partial<Resources>) {
  for (const resource of RESOURCES) {
    const delta =
      (resources[resource] ?? state.players[player].resources[resource]) -
      state.players[player].resources[resource];
    state.players[player].resources[resource] += delta;
    state.bank[resource] -= delta;
  }
}
function withAction(state = setup()): GameState {
  state.phase = 'action';
  return state;
}
function rollTotal(state: GameState, total: number): GameState {
  for (let rng = 0; rng < 1000; rng++) {
    const next = applyAction({ ...state, phase: 'roll', rng }, { type: 'ROLL' });
    if (next.dice && next.dice[0] + next.dice[1] === total) return next;
  }
  throw new Error('No matching dice seed');
}
function assertConserved(state: GameState) {
  for (const resource of RESOURCES) {
    expect(
      state.bank[resource] +
        state.players.reduce((sum, player) => sum + player.resources[resource], 0),
    ).toBe(state.config.mode === 'extension' ? 24 : 19);
    expect(state.bank[resource]).toBeGreaterThanOrEqual(0);
    for (const player of state.players)
      expect(player.resources[resource]).toBeGreaterThanOrEqual(0);
  }
}
function graph(pairs: [number, number][], blocks: Record<number, number> = {}): GameState {
  const state = withAction(newGame());
  const n = Math.max(...pairs.flat()) + 1;
  const board: Board = {
    hexes: [],
    ports: [],
    edges: pairs.map(([a, b], id) => ({ id, a, b, owner: 0 })),
    vertices: Array.from({ length: n }, (_, id) => ({
      id,
      x: id,
      z: 0,
      hexes: [],
      edges: [],
      building: blocks[id] === undefined ? null : { owner: blocks[id], type: 'settlement' },
    })),
  };
  board.edges.forEach((edge) => {
    board.vertices[edge.a].edges.push(edge.id);
    board.vertices[edge.b].edges.push(edge.id);
  });
  state.board = board;
  return state;
}

describe('board generation', () => {
  it('creates canonical topology and components for both modes', () => {
    const base = newGame(),
      extended = newGame(6);
    expect([
      base.board.hexes.length,
      base.board.vertices.length,
      base.board.edges.length,
      base.board.ports.length,
      base.deck.length,
    ]).toEqual([19, 54, 72, 9, 25]);
    expect([
      extended.board.hexes.length,
      extended.board.vertices.length,
      extended.board.edges.length,
      extended.board.ports.length,
      extended.deck.length,
    ]).toEqual([30, 80, 109, 11, 34]);
    expect(extended.board.hexes.filter((h) => h.terrain === 'desert')).toHaveLength(2);
    expect(extended.board.ports.filter((p) => p.type === 'sheep')).toHaveLength(2);
    expect(extended.board.ports.filter((p) => p.type === 'any')).toHaveLength(5);
    for (const state of [base, extended]) {
      for (const vertex of state.board.vertices) {
        expect(vertex.edges.length).toBeGreaterThanOrEqual(2);
        expect(vertex.edges.length).toBeLessThanOrEqual(3);
      }
      expect(new Set(state.board.ports.flatMap((p) => p.vertices)).size).toBe(
        state.board.ports.length * 2,
      );
      assertConserved(state);
    }
  });
  it('replays identical seeds and separates every adjacent 6 and 8', () => {
    for (let seed = 0; seed < 40; seed++)
      for (const count of [4, 6]) {
        const state = newGame(count, `seed-${seed}`);
        if (seed === 0) expect(state).toEqual(newGame(count, `seed-${seed}`));
        const hot = state.board.hexes.filter((h) => h.number === 6 || h.number === 8);
        expect(hot.length).toBe(count === 4 ? 4 : 6);
        for (const a of hot)
          for (const b of hot)
            if (a.id !== b.id) {
              expect(
                Math.max(Math.abs(a.q - b.q), Math.abs(a.r - b.r), Math.abs(a.q - b.q + a.r - b.r)),
              ).toBeGreaterThan(1);
            }
      }
  });
  it('rejects invalid counts, names, and scores', () => {
    expect(() =>
      createGame({
        mode: 'standard',
        names: ['a', 'b', 'c', 'd', 'e'],
        seed: '',
        targetPoints: 10,
      }),
    ).toThrow();
    expect(() =>
      createGame({ mode: 'standard', names: ['a', ''], seed: '', targetPoints: 10 }),
    ).toThrow();
    expect(() =>
      createGame({ mode: 'extension', names: ['a', 'b'], seed: '', targetPoints: 10 }),
    ).toThrow();
  });
});

describe('founding and construction', () => {
  it('uses snake order and gives resources only for the second settlement', () => {
    let state = newGame(6);
    const order: number[] = [];
    for (let i = 0; i < 12; i++) {
      order.push(state.currentPlayer);
      const vertex = legalBuilds(state, 'settlement')[0];
      const player = state.currentPlayer;
      state = applyAction(state, { type: 'BUILD', kind: 'settlement', id: vertex });
      expect(state.phase).toBe('setupRoad');
      expect(resourceCount(state.players[player].resources)).toBe(
        i < 6
          ? 0
          : state.board.vertices[vertex].hexes.filter(
              (id) => state.board.hexes[id].terrain !== 'desert',
            ).length,
      );
      const roads = legalBuilds(state, 'road');
      expect(
        roads.every(
          (id) => state.board.edges[id].a === vertex || state.board.edges[id].b === vertex,
        ),
      ).toBe(true);
      state = applyAction(state, { type: 'BUILD', kind: 'road', id: roads[0] });
    }
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 5, 4, 3, 2, 1, 0]);
    expect(state.phase).toBe('roll');
    expect(state.currentPlayer).toBe(0);
    expect(state.turn).toBe(1);
    expect(state.players.map((p) => score(state, p))).toEqual([2, 2, 2, 2, 2, 2]);
    assertConserved(state);
  });
  it('enforces distance, connectivity, affordability, and immutable rejection', () => {
    let state = newGame();
    const vertex = legalBuilds(state, 'settlement')[0];
    const untouched = structuredClone(state);
    expect(() => applyAction(state, { type: 'BUILD', kind: 'city', id: vertex })).toThrow();
    expect(state).toEqual(untouched);
    state = applyAction(state, { type: 'BUILD', kind: 'settlement', id: vertex });
    state = applyAction(state, { type: 'BUILD', kind: 'road', id: legalBuilds(state, 'road')[0] });
    const legal = legalBuilds(state, 'settlement');
    expect(legal).not.toContain(vertex);
    for (const id of state.board.vertices[vertex].edges) {
      const edge = state.board.edges[id];
      expect(legal).not.toContain(edge.a === vertex ? edge.b : edge.a);
    }
    state = withAction(setup());
    grant(state, 0, emptyResources());
    expect(legalBuilds(state, 'road')).toEqual([]);
    grant(state, 0, COSTS.road);
    const road = legalBuilds(state, 'road')[0];
    const result = applyAction(state, { type: 'BUILD', kind: 'road', id: road });
    expect(result.players[0].resources).toEqual(emptyResources());
    expect(state.board.edges[road].owner).toBeNull();
    expect(result.board.edges[road].owner).toBe(0);
    assertConserved(result);
  });
  it('upgrades a settlement into a city for the correct cost', () => {
    const state = withAction();
    grant(state, 0, COSTS.city);
    const vertex = legalBuilds(state, 'city')[0];
    const next = applyAction(state, { type: 'BUILD', kind: 'city', id: vertex });
    expect(next.board.vertices[vertex].building).toEqual({ owner: 0, type: 'city' });
    expect(score(next, 0)).toBe(3);
    expect(next.players[0].resources).toEqual(emptyResources());
    assertConserved(next);
  });
  it('cannot extend through another player’s settlement', () => {
    const state = graph(
      [
        [0, 1],
        [1, 2],
      ],
      { 1: 1 },
    );
    state.board.edges[1].owner = null;
    grant(state, 0, COSTS.road);
    expect(legalBuilds(state, 'road')).not.toContain(1);
  });
});

describe('production and robber', () => {
  it('produces one per settlement, two per city, and blocks the robber hex', () => {
    const state = newGame();
    state.phase = 'roll';
    state.turn = 1;
    const hex = state.board.hexes.find((h) => h.terrain !== 'desert')!;
    state.board.hexes.forEach((h) => {
      h.number = h.id === hex.id ? 8 : 0;
    });
    state.board.vertices[hex.vertices[0]].building = { owner: 0, type: 'settlement' };
    state.board.vertices[hex.vertices[2]].building = { owner: 1, type: 'city' };
    const produced = rollTotal(state, 8);
    expect(resourceCount(produced.players[0].resources)).toBe(1);
    expect(resourceCount(produced.players[1].resources)).toBe(2);
    assertConserved(produced);
    state.robberHex = hex.id;
    expect(rollTotal(state, 8).players.every((p) => resourceCount(p.resources) === 0)).toBe(true);
  });
  it('handles bank shortages collectively and the single-recipient exception', () => {
    const state = newGame();
    state.phase = 'roll';
    const hex = state.board.hexes.find((h) => h.terrain === 'wood')!;
    state.board.hexes.forEach((h) => {
      h.number = h.id === hex.id ? 8 : 0;
    });
    state.board.vertices[hex.vertices[0]].building = { owner: 0, type: 'city' };
    state.board.vertices[hex.vertices[2]].building = { owner: 1, type: 'city' };
    grant(state, 2, { wood: 16 });
    const denied = rollTotal(state, 8);
    expect(denied.players[0].resources.wood).toBe(0);
    expect(denied.players[1].resources.wood).toBe(0);
    expect(denied.bank.wood).toBe(3);
    state.board.vertices[hex.vertices[2]].building = { owner: 0, type: 'city' };
    const partial = rollTotal(state, 8);
    expect(partial.players[0].resources.wood).toBe(3);
    expect(partial.bank.wood).toBe(0);
    assertConserved(partial);
  });
  it('discards half above seven and then steals a hidden random card', () => {
    let state = setup();
    state.players.forEach((p) => grant(state, p.id, emptyResources()));
    grant(state, 0, { wood: 9 });
    grant(state, 1, { brick: 8 });
    grant(state, 2, { sheep: 7 });
    state = rollTotal(state, 7);
    expect(state.phase).toBe('discard');
    expect(state.discardQueue).toEqual([0, 1]);
    expect(() =>
      applyAction(state, {
        type: 'DISCARD',
        player: 0,
        resources: { ...emptyResources(), wood: 3 },
      }),
    ).toThrow();
    expect(() =>
      applyAction(state, {
        type: 'DISCARD',
        player: 0,
        resources: { ...emptyResources(), wood: 3.5, ore: 0.5 },
      }),
    ).toThrow();
    state = applyAction(state, {
      type: 'DISCARD',
      player: 1,
      resources: { ...emptyResources(), brick: 4 },
    });
    state = applyAction(state, {
      type: 'DISCARD',
      player: 0,
      resources: { ...emptyResources(), wood: 4 },
    });
    expect(state.phase).toBe('robber');
    expect(() => applyAction(state, { type: 'MOVE_ROBBER', hex: state.robberHex })).toThrow();
    const victimVertex = state.board.vertices.find((v) => v.building?.owner === 1)!;
    const destination = victimVertex.hexes.find((id) => id !== state.robberHex)!;
    state = applyAction(state, { type: 'MOVE_ROBBER', hex: destination });
    expect(state.stealTargets).toContain(1);
    state = applyAction(state, { type: 'STEAL', player: 1 });
    expect(state.players[0].resources.brick).toBe(1);
    expect(state.players[1].resources.brick).toBe(3);
    expect(state.phase).toBe('action');
    expect(state.log.at(-1)?.text).not.toMatch(/brick/i);
    assertConserved(state);
  });
});

describe('trading', () => {
  it('honors specialized and generic ports', () => {
    const state = withAction(newGame());
    expect(tradeRate(state, 0, 'wood')).toBe(4);
    const generic = state.board.ports.find((p) => p.type === 'any')!;
    state.board.vertices[generic.vertices[0]].building = { owner: 0, type: 'settlement' };
    expect(tradeRate(state, 0, 'wood')).toBe(3);
    const wood = state.board.ports.find((p) => p.type === 'wood')!;
    state.board.vertices[wood.vertices[0]].building = { owner: 0, type: 'settlement' };
    expect(tradeRate(state, 0, 'wood')).toBe(2);
    grant(state, 0, { wood: 2 });
    const next = applyAction(state, { type: 'BANK_TRADE', give: 'wood', receive: 'ore' });
    expect(next.players[0].resources).toEqual({ ...emptyResources(), ore: 1 });
    assertConserved(next);
  });
  it('atomically exchanges accepted domestic offers and rejects impossible or free trades', () => {
    const state = withAction(newGame());
    grant(state, 0, { wood: 2 });
    grant(state, 1, { ore: 1 });
    const action: GameAction = {
      type: 'PLAYER_TRADE',
      player: 1,
      give: { ...emptyResources(), wood: 2 },
      receive: { ...emptyResources(), ore: 1 },
    };
    const next = applyAction(state, action);
    expect(next.players[0].resources).toEqual({ ...emptyResources(), ore: 1 });
    expect(next.players[1].resources).toEqual({ ...emptyResources(), wood: 2 });
    expect(next.bank).toEqual(state.bank);
    expect(() => applyAction(next, action)).toThrow();
    expect(() => applyAction(state, { ...action, receive: emptyResources() })).toThrow();
    expect(() =>
      applyAction(state, { ...action, receive: { ...emptyResources(), wood: 1 } }),
    ).toThrow();
  });
});

describe('development cards and turns', () => {
  it('keeps purchases hidden and cannot play cards bought this turn', () => {
    const state = withAction();
    grant(state, 0, COSTS.development);
    state.deck[state.deck.length - 1] = 'knight';
    const next = applyAction(state, { type: 'BUY_DEV' });
    expect(next.deck.length).toBe(24);
    expect(next.players[0].devCards[0].type).toBe('knight');
    expect(next.log.at(-1)?.text).not.toMatch(/knight/i);
    expect(() =>
      applyAction(next, { type: 'PLAY_DEV', card: next.players[0].devCards[0].id }),
    ).toThrow(/turn you bought/i);
    assertConserved(next);
  });
  it('plays a pre-roll Knight and resumes the required dice roll', () => {
    let state = setup();
    state.players[0].devCards.push({ id: 24, type: 'knight', boughtTurn: 0 });
    state = applyAction(state, { type: 'PLAY_DEV', card: 24 });
    expect(state.phase).toBe('robber');
    expect(state.players[0].knights).toBe(1);
    const empty = state.board.hexes.find(
      (h) =>
        h.id !== state.robberHex && h.vertices.every((id) => !state.board.vertices[id].building),
    )!;
    state = applyAction(state, { type: 'MOVE_ROBBER', hex: empty.id });
    expect(state.phase).toBe('roll');
    expect(state.devPlayed).toBe(true);
    expect(() => applyAction(state, { type: 'END_TURN' })).toThrow();
  });
  it('resolves pre-roll Road Building without charging resources and returns to roll', () => {
    let state = setup();
    state.players[0].devCards.push({ id: 24, type: 'roadBuilding', boughtTurn: 0 });
    const before = structuredClone(state.players[0].resources);
    state = applyAction(state, { type: 'PLAY_DEV', card: 24 });
    expect(state.freeRoads).toBe(2);
    expect(() => applyAction(state, { type: 'END_TURN' })).toThrow();
    state = applyAction(state, { type: 'BUILD', kind: 'road', id: legalBuilds(state, 'road')[0] });
    state = applyAction(state, { type: 'BUILD', kind: 'road', id: legalBuilds(state, 'road')[0] });
    expect(state.phase).toBe('roll');
    expect(state.freeRoads).toBe(0);
    expect(state.players[0].resources).toEqual(before);
  });
  it('Year of Plenty checks supply and Monopoly transfers all of the selected resource', () => {
    let state = withAction();
    state.players.forEach((p) => grant(state, p.id, emptyResources()));
    state.players[0].devCards.push({ id: 23, type: 'yearOfPlenty', boughtTurn: 0 });
    state.players[0].devCards.push({ id: 24, type: 'monopoly', boughtTurn: 0 });
    state = applyAction(state, { type: 'PLAY_DEV', card: 23, resources: ['ore', 'ore'] });
    expect(state.players[0].resources.ore).toBe(2);
    expect(() => applyAction(state, { type: 'PLAY_DEV', card: 24, resource: 'wood' })).toThrow(
      /one development/i,
    );
    state.devPlayed = false;
    grant(state, 1, { wood: 4 });
    grant(state, 2, { wood: 2 });
    state = applyAction(state, { type: 'PLAY_DEV', card: 24, resource: 'wood' });
    expect(state.players[0].resources.wood).toBe(6);
    expect(state.players[1].resources.wood).toBe(0);
    expect(state.players[2].resources.wood).toBe(0);
    assertConserved(state);
  });
  it('cycles standard turns and extension primary/paired phases correctly', () => {
    let standard = withAction();
    standard = applyAction(standard, { type: 'END_TURN' });
    expect([standard.currentPlayer, standard.phase, standard.paired]).toEqual([1, 'roll', false]);
    for (const count of [5, 6]) {
      let state = withAction(setup(count));
      const seen: number[] = [];
      for (let i = 0; i < count; i++) {
        seen.push(state.currentPlayer);
        state.phase = 'action';
        state = applyAction(state, { type: 'END_TURN' });
        seen.push(state.currentPlayer);
        expect(state.currentPlayer).toBe((i + 3) % count);
        expect(state.phase).toBe('action');
        expect(state.paired).toBe(true);
        expect(() => applyAction(state, { type: 'ROLL' })).toThrow();
        expect(() =>
          applyAction(state, {
            type: 'PLAYER_TRADE',
            player: 0,
            give: COSTS.road,
            receive: COSTS.city,
          }),
        ).toThrow(/paired/i);
        state = applyAction(state, { type: 'END_TURN' });
        expect(state.phase).toBe('roll');
      }
      expect(state.currentPlayer).toBe(0);
      expect(state.round).toBe(2);
      expect(state.turn).toBe(1 + count * 2);
      expect(seen.length).toBe(count * 2);
    }
  });
  it('allows a card bought in the paired phase on a later primary turn', () => {
    let state = withAction(setup(6));
    state = applyAction(state, { type: 'END_TURN' });
    grant(state, 3, COSTS.development);
    state.deck[state.deck.length - 1] = 'yearOfPlenty';
    state = applyAction(state, { type: 'BUY_DEV' });
    const id = state.players[3].devCards[0].id;
    while (!(state.currentPlayer === 3 && !state.paired)) {
      state.phase = 'action';
      state = applyAction(state, { type: 'END_TURN' });
    }
    expect(() =>
      applyAction(state, { type: 'PLAY_DEV', card: id, resources: ['wood', 'brick'] }),
    ).not.toThrow();
  });
});

describe('awards and victory', () => {
  it('counts chains, forks, loops, and blockers without reusing a road', () => {
    expect(
      longestRoadLength(
        graph([
          [0, 1],
          [1, 2],
          [2, 3],
          [3, 4],
          [4, 5],
        ]),
        0,
      ),
    ).toBe(5);
    expect(
      longestRoadLength(
        graph([
          [0, 1],
          [1, 2],
          [1, 3],
        ]),
        0,
      ),
    ).toBe(2);
    expect(
      longestRoadLength(
        graph([
          [0, 1],
          [1, 2],
          [2, 3],
          [3, 4],
          [4, 5],
          [5, 0],
        ]),
        0,
      ),
    ).toBe(6);
    expect(
      longestRoadLength(
        graph(
          [
            [0, 1],
            [1, 2],
            [2, 3],
            [3, 4],
            [4, 5],
          ],
          { 2: 1 },
        ),
        0,
      ),
    ).toBe(3);
  });
  it('retains tied Longest Road and transfers it only for a longer trail', () => {
    let state = graph([
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [6, 7],
      [7, 8],
      [8, 9],
      [9, 10],
      [10, 11],
      [11, 12],
    ]);
    state.board.edges.slice(5, 9).forEach((edge) => {
      edge.owner = 1;
    });
    state.board.edges[9].owner = null;
    state.board.edges[10].owner = null;
    state.longestRoad = 0;
    state.currentPlayer = 1;
    grant(state, 1, { wood: 2, brick: 2 });
    state = applyAction(state, { type: 'BUILD', kind: 'road', id: 9 });
    expect(state.longestRoad).toBe(0);
    state = applyAction(state, { type: 'BUILD', kind: 'road', id: 10 });
    expect(state.longestRoad).toBe(1);
    expect(state.players[1].roadLength).toBe(6);
  });
  it('awards Largest Army at three and counts hidden victory cards only on owner turn', () => {
    let state = withAction();
    state.players[0].knights = 2;
    state.players[0].devCards = [{ id: 1, type: 'knight', boughtTurn: 0 }];
    state = applyAction(state, { type: 'PLAY_DEV', card: 1 });
    expect(state.largestArmy).toBe(0);
    expect(score(state, 0)).toBe(4);
    const fresh = withAction();
    fresh.config.targetPoints = 3;
    fresh.players[1].devCards = [{ id: 24, type: 'victory', boughtTurn: 0 }];
    expect(score(fresh, 1, false)).toBe(2);
    expect(score(fresh, 1, true)).toBe(3);
    expect(fresh.winner).toBeNull();
    const next = applyAction(fresh, { type: 'END_TURN' });
    expect(next.winner).toBe(1);
    expect(next.phase).toBe('gameOver');
  });
  it('wins immediately when buying the decisive VP card and blocks further actions', () => {
    const state = withAction();
    state.config.targetPoints = 3;
    grant(state, 0, COSTS.development);
    state.deck[state.deck.length - 1] = 'victory';
    const next = applyAction(state, { type: 'BUY_DEV' });
    expect(next.winner).toBe(0);
    expect(next.phase).toBe('gameOver');
    expect(() => applyAction(next, { type: 'END_TURN' })).toThrow(/already ended/i);
  });
});
