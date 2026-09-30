import { expect, it } from 'vitest';
import {
  applyAction,
  COSTS,
  createGame,
  emptyResources,
  legalBuilds,
  RESOURCES,
  resourceCount,
  score,
  tradeRate,
} from './engine';
import type { BuildKind, GameAction, GameState, Resource, Resources } from './types';

// These agents play complete games with ordinary production and no injected resources.
// Their policy is deliberately small: improve production, expand, then buy developments.
function potential(state: GameState, kind: BuildKind): number[] {
  const probe = structuredClone(state);
  for (const resource of RESOURCES) probe.players[probe.currentPlayer].resources[resource] = 99;
  return legalBuilds(probe, kind);
}
const canAfford = (state: GameState, cost: Resources) =>
  RESOURCES.every((r) => state.players[state.currentPlayer].resources[r] >= cost[r]);
function siteValue(state: GameState, id: number): number {
  const vertex = state.board.vertices[id];
  let value = 0;
  const kinds = new Set<Resource>();
  for (const hexId of vertex.hexes) {
    const hex = state.board.hexes[hexId];
    if (hex.terrain === 'desert') continue;
    kinds.add(hex.terrain);
    value +=
      (6 - Math.abs(7 - hex.number)) *
      (hex.terrain === 'ore' || hex.terrain === 'wheat' ? 1.15 : 1);
  }
  return value + kinds.size * 1.3 + (vertex.port ? 0.6 : 0);
}
function bestSite(state: GameState, ids: number[]): number {
  return [...ids].sort((a, b) => siteValue(state, b) - siteValue(state, a) || a - b)[0];
}
function bestRoad(state: GameState, ids: number[]): number {
  // Favor new frontier intersections with promising empty sites nearby.
  const current = state.currentPlayer;
  const value = (id: number) => {
    const edge = state.board.edges[id];
    return Math.max(
      ...[edge.a, edge.b].map((vertexId) => {
        const vertex = state.board.vertices[vertexId];
        if (vertex.building) return -50;
        const alreadyReached = vertex.edges.some(
          (other) => state.board.edges[other].owner === current,
        );
        const nearby = vertex.edges.map((other) => {
          const e = state.board.edges[other];
          const v = state.board.vertices[e.a === vertexId ? e.b : e.a];
          return v.building ? -5 : siteValue(state, v.id);
        });
        return siteValue(state, vertexId) + Math.max(...nearby) - (alreadyReached ? 30 : 0);
      }),
    );
  };
  return [...ids].sort((a, b) => value(b) - value(a) || a - b)[0];
}
function chooseAction(state: GameState): GameAction {
  const player = state.players[state.currentPlayer];
  if (state.phase === 'setupSettlement')
    return {
      type: 'BUILD',
      kind: 'settlement',
      id: bestSite(state, legalBuilds(state, 'settlement')),
    };
  if (state.phase === 'setupRoad')
    return { type: 'BUILD', kind: 'road', id: bestRoad(state, legalBuilds(state, 'road')) };
  if (state.phase === 'discard') {
    const id = state.discardQueue[0],
      inventory = { ...state.players[id].resources },
      discarded = emptyResources();
    const count = Math.floor(resourceCount(inventory) / 2);
    for (let i = 0; i < count; i++) {
      const resource = [...RESOURCES].sort((a, b) => inventory[b] - inventory[a])[0];
      discarded[resource]++;
      inventory[resource]--;
    }
    return { type: 'DISCARD', player: id, resources: discarded };
  }
  if (state.phase === 'robber') {
    const hex = state.board.hexes
      .filter((h) => h.id !== state.robberHex)
      .sort((a, b) => {
        const value = (id: number) =>
          state.board.hexes[id].vertices.reduce((sum, vertex) => {
            const building = state.board.vertices[vertex].building;
            return (
              sum +
              (building
                ? building.owner === player.id
                  ? -100
                  : 10 + score(state, building.owner)
                : 0)
            );
          }, 0);
        return value(b.id) - value(a.id);
      })[0];
    return { type: 'MOVE_ROBBER', hex: hex.id };
  }
  if (state.phase === 'steal')
    return {
      type: 'STEAL',
      player: [...state.stealTargets].sort(
        (a, b) =>
          resourceCount(state.players[b].resources) - resourceCount(state.players[a].resources),
      )[0],
    };
  if (state.freeRoads) {
    const roads = legalBuilds(state, 'road');
    return roads.length
      ? { type: 'BUILD', kind: 'road', id: bestRoad(state, roads) }
      : { type: 'SKIP_FREE_ROADS' };
  }
  if (state.phase === 'roll') return { type: 'ROLL' };
  if (state.phase !== 'action') throw new Error(`Agent reached unexpected phase ${state.phase}`);

  const cities = potential(state, 'city'),
    settlements = potential(state, 'settlement'),
    roads = potential(state, 'road');
  const buildings = state.board.vertices.filter((v) => v.building?.owner === player.id).length;
  const goal: BuildKind | 'development' = settlements.length
    ? 'settlement'
    : cities.length
      ? 'city'
      : buildings < 4 && roads.length
        ? 'road'
        : state.deck.length
          ? 'development'
          : roads.length
            ? 'road'
            : 'city';
  const cost = COSTS[goal];
  if (!state.devPlayed) {
    for (const card of player.devCards.filter(
      (card) => card.type !== 'victory' && card.boughtTurn < state.turn,
    )) {
      if (card.type === 'knight') return { type: 'PLAY_DEV', card: card.id };
      if (card.type === 'roadBuilding' && roads.length) return { type: 'PLAY_DEV', card: card.id };
      if (card.type === 'monopoly') {
        const resource = [...RESOURCES].sort((a, b) =>
          state.players
            .filter((p) => p.id !== player.id)
            .reduce((sum, p) => sum + p.resources[b] - p.resources[a], 0),
        )[0];
        return { type: 'PLAY_DEV', card: card.id, resource };
      }
      if (card.type === 'yearOfPlenty') {
        const supply = { ...state.bank },
          inventory = { ...player.resources },
          resources: Resource[] = [];
        for (let i = 0; i < Math.min(2, resourceCount(state.bank)); i++) {
          const resource = RESOURCES.filter((r) => supply[r] > 0).sort(
            (a, b) => cost[b] - inventory[b] - (cost[a] - inventory[a]),
          )[0];
          resources.push(resource);
          supply[resource]--;
          inventory[resource]++;
        }
        return { type: 'PLAY_DEV', card: card.id, resources };
      }
    }
  }
  for (const kind of ['city', 'settlement'] as const) {
    const ids = legalBuilds(state, kind);
    if (ids.length) return { type: 'BUILD', kind, id: bestSite(state, ids) };
  }
  if (goal === 'road' && canAfford(state, cost))
    return { type: 'BUILD', kind: 'road', id: bestRoad(state, roads) };
  if (state.deck.length && canAfford(state, COSTS.development)) return { type: 'BUY_DEV' };
  const lacking = RESOURCES.filter((r) => player.resources[r] < cost[r] && state.bank[r] > 0).sort(
    (a, b) => cost[b] - player.resources[b] - cost[a] + player.resources[a],
  );
  for (const receive of lacking) {
    const give = [...RESOURCES]
      .filter((r) => r !== receive && player.resources[r] - cost[r] >= tradeRate(state, player, r))
      .sort((a, b) => player.resources[b] - player.resources[a])[0];
    if (give) return { type: 'BANK_TRADE', give, receive };
    if (!state.paired) {
      for (const partner of state.players.filter(
        (p) => p.id !== player.id && p.resources[receive] > 2,
      )) {
        const offered = RESOURCES.find(
          (r) => r !== receive && player.resources[r] > cost[r] + 1 && partner.resources[r] < 2,
        );
        if (offered)
          return {
            type: 'PLAYER_TRADE',
            player: partner.id,
            give: { ...emptyResources(), [offered]: 1 },
            receive: { ...emptyResources(), [receive]: 1 },
          };
      }
    }
  }
  return { type: 'END_TURN' };
}

it.each([4, 6])(
  'finishes a real %i-player match while conserving resources and obeying piece limits',
  (count) => {
    let state = createGame({
      mode: count === 4 ? 'standard' : 'extension',
      names: Array.from({ length: count }, (_, i) => `Agent ${i}`),
      seed: `complete-match-${count}`,
      targetPoints: 10,
    });
    const actions = new Set<string>();
    let transitions = 0;
    for (; transitions < 20000 && state.winner === null; transitions++) {
      const action = chooseAction(state);
      actions.add(action.type);
      if (action.type === 'BUILD') actions.add(action.kind);
      if (action.type === 'PLAY_DEV')
        actions.add(
          state.players[state.currentPlayer].devCards.find((c) => c.id === action.card)!.type,
        );
      try {
        state = applyAction(state, action);
      } catch (error) {
        throw new Error(
          `Match blocked after ${transitions} actions in ${state.phase} at turn ${state.turn}: ${JSON.stringify(action)}; ${String(error)}`,
        );
      }
      for (const resource of RESOURCES) {
        const total =
          state.bank[resource] +
          state.players.reduce((sum, player) => sum + player.resources[resource], 0);
        if (
          total !== (count === 4 ? 19 : 24) ||
          state.bank[resource] < 0 ||
          state.players.some(
            (p) => !Number.isInteger(p.resources[resource]) || p.resources[resource] < 0,
          )
        )
          throw new Error(`Resource conservation failed for ${resource} at action ${transitions}`);
      }
      for (const player of state.players) {
        const settlements = state.board.vertices.filter(
          (v) => v.building?.owner === player.id && v.building.type === 'settlement',
        ).length;
        const cities = state.board.vertices.filter(
          (v) => v.building?.owner === player.id && v.building.type === 'city',
        ).length;
        const roads = state.board.edges.filter((e) => e.owner === player.id).length;
        if (settlements > 5 || cities > 4 || roads > 15)
          throw new Error(`Piece limit exceeded at action ${transitions}`);
      }
    }
    expect(
      state.winner,
      `No winner after ${transitions} actions, round ${state.round}; scores ${state.players.map((p) => score(state, p))}`,
    ).not.toBeNull();
    expect(state.phase).toBe('gameOver');
    expect(state.winner).toBe(state.currentPlayer);
    expect(score(state, state.winner!)).toBeGreaterThanOrEqual(10);
    for (const required of [
      'ROLL',
      'DISCARD',
      'MOVE_ROBBER',
      'STEAL',
      'BANK_TRADE',
      'PLAYER_TRADE',
      'BUY_DEV',
      'PLAY_DEV',
      'END_TURN',
      'road',
      'settlement',
      'city',
    ])
      expect(actions.has(required), `Simulation did not exercise ${required}`).toBe(true);
    expect(state.turn).toBeGreaterThan(count);
  },
  15000,
);
