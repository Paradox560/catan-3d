import { createBoard, shuffle } from './board';
import type {
  BuildKind,
  DevType,
  GameAction,
  GameConfig,
  GameState,
  Player,
  Resource,
  Resources,
} from './types';

export const RESOURCES: Resource[] = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
export const RESOURCE_NAMES: Record<Resource, string> = {
  wood: 'Lumber',
  brick: 'Brick',
  sheep: 'Wool',
  wheat: 'Grain',
  ore: 'Ore',
};
export const COLORS = ['#e87955', '#64a9ed', '#e7d6a4', '#bd93e3', '#7baa72', '#e2b04d'];
export const emptyResources = (): Resources => ({ wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 });
export const COSTS: Record<BuildKind | 'development', Resources> = {
  road: { ...emptyResources(), wood: 1, brick: 1 },
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1, ore: 0 },
  city: { ...emptyResources(), wheat: 2, ore: 3 },
  development: { ...emptyResources(), sheep: 1, wheat: 1, ore: 1 },
};
export const resourceCount = (resources: Resources): number =>
  RESOURCES.reduce((sum, resource) => sum + resources[resource], 0);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const isResource = (value: unknown): value is Resource => RESOURCES.includes(value as Resource);
function validResources(value: Resources): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    RESOURCES.every((resource) => Number.isSafeInteger(value[resource]) && value[resource] >= 0) &&
    Object.keys(value).every(isResource)
  );
}
function hashSeed(seed: string): number {
  let value = 2166136261;
  for (let i = 0; i < seed.length; i++) value = Math.imul(value ^ seed.charCodeAt(i), 16777619);
  return value >>> 0;
}
function random(state: { rng: number }): number {
  state.rng = (state.rng + 0x6d2b79f5) >>> 0;
  let value = state.rng;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}
function log(state: GameState, text: string, player?: number) {
  const id = (state.log.at(-1)?.id ?? 0) + 1;
  state.log.push({ id, text, ...(player === undefined ? {} : { player }) });
  if (state.log.length > 160) state.log.splice(0, state.log.length - 160);
}
function canPay(resources: Resources, cost: Resources): boolean {
  return RESOURCES.every((resource) => resources[resource] >= cost[resource]);
}
function pay(state: GameState, player: Player, cost: Resources) {
  assert(canPay(player.resources, cost), 'You do not have the resources for that purchase.');
  for (const resource of RESOURCES) {
    player.resources[resource] -= cost[resource];
    state.bank[resource] += cost[resource];
  }
}
function receive(state: GameState, player: Player, resource: Resource, count: number) {
  assert(
    state.bank[resource] >= count,
    `The supply does not have enough ${RESOURCE_NAMES[resource].toLowerCase()}.`,
  );
  state.bank[resource] -= count;
  player.resources[resource] += count;
}
export function createGame(config: GameConfig): GameState {
  assert(
    config && (config.mode === 'standard' || config.mode === 'extension'),
    'Choose a valid game mode.',
  );
  assert(Array.isArray(config.names), 'Player names are required.');
  const min = config.mode === 'extension' ? 5 : 2;
  const max = config.mode === 'extension' ? 6 : 4;
  assert(
    config.names.length >= min && config.names.length <= max,
    `${config.mode === 'extension' ? 'Extension' : 'Standard'} mode requires ${min}–${max} players.`,
  );
  assert(
    config.names.every(
      (name) => typeof name === 'string' && name.trim().length > 0 && name.trim().length <= 32,
    ),
    'Use player names between 1 and 32 characters.',
  );
  assert(
    typeof config.seed === 'string' && config.seed.length <= 200,
    'Use a board seed of at most 200 characters.',
  );
  assert(
    Number.isInteger(config.targetPoints) && config.targetPoints >= 3 && config.targetPoints <= 20,
    'The winning score must be between 3 and 20.',
  );
  const rng = { rng: hashSeed(config.seed) };
  const board = createBoard(config.mode, () => random(rng));
  const expanded = config.mode === 'extension';
  const deck: DevType[] = [
    ...Array<DevType>(expanded ? 20 : 14).fill('knight'),
    ...Array<DevType>(5).fill('victory'),
    ...Array<DevType>(expanded ? 3 : 2).fill('roadBuilding'),
    ...Array<DevType>(expanded ? 3 : 2).fill('yearOfPlenty'),
    ...Array<DevType>(expanded ? 3 : 2).fill('monopoly'),
  ];
  const shuffledDeck = shuffle(deck, () => random(rng));
  const state: GameState = {
    version: 1,
    config: { ...config, names: config.names.map((name) => name.trim()) },
    board,
    players: config.names.map((name, id) => ({
      id,
      name: name.trim(),
      color: COLORS[id],
      resources: emptyResources(),
      devCards: [],
      knights: 0,
      roadLength: 0,
    })),
    bank: Object.fromEntries(
      RESOURCES.map((resource) => [resource, expanded ? 24 : 19]),
    ) as Resources,
    deck: shuffledDeck,
    currentPlayer: 0,
    primaryPlayer: 0,
    paired: false,
    turn: 0,
    round: 1,
    phase: 'setupSettlement',
    setupStep: 0,
    setupVertex: null,
    dice: null,
    robberHex: board.hexes.find((hex) => hex.terrain === 'desert')!.id,
    discardQueue: [],
    stealTargets: [],
    resumePhase: 'action',
    freeRoads: 0,
    devPlayed: false,
    longestRoad: null,
    largestArmy: null,
    winner: null,
    log: [],
    rng: rng.rng,
  };
  log(
    state,
    `${expanded ? 'The expanded island' : 'The island'} is ready. Place two settlements and roads in snake order.`,
  );
  return state;
}

export function score(state: GameState, player: number | Player, includeHidden = true): number {
  const id = typeof player === 'number' ? player : player.id;
  const buildings = state.board.vertices.reduce(
    (sum, vertex) =>
      sum + (vertex.building?.owner === id ? (vertex.building.type === 'city' ? 2 : 1) : 0),
    0,
  );
  return (
    buildings +
    (state.longestRoad === id ? 2 : 0) +
    (state.largestArmy === id ? 2 : 0) +
    (includeHidden
      ? state.players[id].devCards.filter((card) => card.type === 'victory').length
      : 0)
  );
}
export function tradeRate(state: GameState, player: number | Player, resource: Resource): number {
  const id = typeof player === 'number' ? player : player.id;
  const ports = state.board.vertices
    .filter((vertex) => vertex.building?.owner === id)
    .map((vertex) => vertex.port);
  return ports.includes(resource) ? 2 : ports.includes('any') ? 3 : 4;
}
function pieceCount(state: GameState, player: number, kind: BuildKind): number {
  if (kind === 'road') return state.board.edges.filter((edge) => edge.owner === player).length;
  return state.board.vertices.filter(
    (vertex) => vertex.building?.owner === player && vertex.building.type === kind,
  ).length;
}
function roadConnects(state: GameState, vertexId: number, player: number): boolean {
  const vertex = state.board.vertices[vertexId];
  if (vertex.building) return vertex.building.owner === player;
  return vertex.edges.some((id) => state.board.edges[id].owner === player);
}
export function legalBuilds(state: GameState, kind: BuildKind): number[] {
  const player = state.currentPlayer;
  const isSetup = state.phase === 'setupSettlement' || state.phase === 'setupRoad';
  if (state.winner !== null || (state.phase !== 'action' && !isSetup)) return [];
  if (state.phase === 'setupSettlement' && kind !== 'settlement') return [];
  if (state.phase === 'setupRoad' && kind !== 'road') return [];
  if (state.freeRoads > 0 && kind !== 'road') return [];
  if (pieceCount(state, player, kind) >= (kind === 'road' ? 15 : kind === 'settlement' ? 5 : 4))
    return [];
  if (
    !isSetup &&
    !(kind === 'road' && state.freeRoads > 0) &&
    !canPay(state.players[player].resources, COSTS[kind])
  )
    return [];
  if (kind === 'road') {
    return state.board.edges
      .filter(
        (edge) =>
          edge.owner === null &&
          (state.phase === 'setupRoad'
            ? edge.a === state.setupVertex || edge.b === state.setupVertex
            : roadConnects(state, edge.a, player) || roadConnects(state, edge.b, player)),
      )
      .map((edge) => edge.id);
  }
  if (kind === 'city')
    return state.board.vertices
      .filter(
        (vertex) => vertex.building?.owner === player && vertex.building.type === 'settlement',
      )
      .map((vertex) => vertex.id);
  return state.board.vertices
    .filter(
      (vertex) =>
        !vertex.building &&
        vertex.edges.every((id) => {
          const edge = state.board.edges[id];
          return !state.board.vertices[edge.a === vertex.id ? edge.b : edge.a].building;
        }) &&
        (state.phase === 'setupSettlement' ||
          vertex.edges.some((id) => state.board.edges[id].owner === player)),
    )
    .map((vertex) => vertex.id);
}

/** Longest edge-simple trail; branches cannot be counted twice, cycles can count once. */
export function longestRoadLength(state: GameState, player: number): number {
  const roads = state.board.edges.filter((edge) => edge.owner === player);
  if (!roads.length) return 0;
  const bitFor = new Map(roads.map((edge, index) => [edge.id, 1 << index]));
  const memo = new Map<string, number>();
  const walk = (vertexId: number, used: number): number => {
    const vertex = state.board.vertices[vertexId];
    if (used !== 0 && vertex.building && vertex.building.owner !== player) return 0;
    const key = `${vertexId}:${used}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let best = 0;
    for (const id of vertex.edges) {
      const bit = bitFor.get(id);
      if (bit === undefined || used & bit) continue;
      const edge = state.board.edges[id];
      best = Math.max(best, 1 + walk(edge.a === vertexId ? edge.b : edge.a, used | bit));
    }
    memo.set(key, best);
    return best;
  };
  return Math.max(
    ...[...new Set(roads.flatMap((edge) => [edge.a, edge.b]))].map((vertex) => walk(vertex, 0)),
  );
}
function awardHolder(values: number[], minimum: number, incumbent: number | null): number | null {
  const best = Math.max(...values);
  if (best < minimum) return null;
  const leaders = values.map((value, id) => (value === best ? id : -1)).filter((id) => id >= 0);
  if (incumbent !== null && leaders.includes(incumbent)) return incumbent;
  return leaders.length === 1 ? leaders[0] : null;
}
function refreshAwards(state: GameState) {
  state.players.forEach((player) => {
    player.roadLength = longestRoadLength(state, player.id);
  });
  const road = awardHolder(
    state.players.map((player) => player.roadLength),
    5,
    state.longestRoad,
  );
  const army = awardHolder(
    state.players.map((player) => player.knights),
    3,
    state.largestArmy,
  );
  if (road !== state.longestRoad) {
    state.longestRoad = road;
    log(
      state,
      road === null
        ? 'Longest Road is unclaimed.'
        : `${state.players[road].name} takes Longest Road.`,
      road ?? undefined,
    );
  }
  if (army !== state.largestArmy) {
    state.largestArmy = army;
    log(
      state,
      army === null
        ? 'Largest Army is unclaimed.'
        : `${state.players[army].name} takes Largest Army.`,
      army ?? undefined,
    );
  }
}
function checkVictory(state: GameState) {
  if (state.phase === 'setupSettlement' || state.phase === 'setupRoad' || state.winner !== null)
    return;
  if (score(state, state.currentPlayer) >= state.config.targetPoints) {
    state.winner = state.currentPlayer;
    state.phase = 'gameOver';
    state.freeRoads = 0;
    log(
      state,
      `${state.players[state.currentPlayer].name} wins with ${score(state, state.currentPlayer)} victory points!`,
      state.currentPlayer,
    );
  }
}
function requireAction(state: GameState) {
  assert(state.phase === 'action', 'Finish the current phase before taking this action.');
  assert(state.freeRoads === 0, 'Place your free roads or finish Road Building first.');
}
function finishFreeRoads(state: GameState) {
  state.freeRoads = 0;
  state.phase = state.resumePhase;
  state.resumePhase = 'action';
}
function nextTurn(state: GameState) {
  const expanded = state.config.mode === 'extension';
  if (expanded && !state.paired) {
    state.paired = true;
    state.currentPlayer = (state.primaryPlayer + 3) % state.players.length;
    state.phase = 'action';
  } else {
    state.paired = false;
    state.primaryPlayer = (state.primaryPlayer + 1) % state.players.length;
    state.currentPlayer = state.primaryPlayer;
    if (state.primaryPlayer === 0) state.round++;
    state.phase = 'roll';
    state.dice = null;
  }
  state.turn++;
  state.devPlayed = false;
  state.resumePhase = 'action';
  state.freeRoads = 0;
  log(
    state,
    `${state.players[state.currentPlayer].name}'s ${state.paired ? 'paired action phase' : 'turn'} begins.`,
    state.currentPlayer,
  );
}
function distributeProduction(state: GameState, value: number) {
  const owed = state.players.map(() => emptyResources());
  for (const hex of state.board.hexes) {
    if (hex.id === state.robberHex || hex.number !== value || hex.terrain === 'desert') continue;
    for (const id of hex.vertices) {
      const building = state.board.vertices[id].building;
      if (building) owed[building.owner][hex.terrain] += building.type === 'city' ? 2 : 1;
    }
  }
  let distributed = 0;
  for (const resource of RESOURCES) {
    const recipients = state.players.filter((player) => owed[player.id][resource] > 0);
    const total = recipients.reduce((sum, player) => sum + owed[player.id][resource], 0);
    if (total > state.bank[resource] && recipients.length > 1) {
      log(
        state,
        `The ${RESOURCE_NAMES[resource].toLowerCase()} supply is too low; nobody receives that resource.`,
      );
      continue;
    }
    for (const player of recipients) {
      const count = Math.min(owed[player.id][resource], state.bank[resource]);
      receive(state, player, resource, count);
      distributed += count;
    }
  }
  log(
    state,
    distributed > 0
      ? `${distributed} resource ${distributed === 1 ? 'card is' : 'cards are'} produced.`
      : 'No resources are produced.',
  );
}

/** Pure transition: rejected actions never alter the caller's state. Actor identity is enforced by the room server. */
export function applyAction(previous: GameState, action: GameAction): GameState {
  assert(previous.winner === null && previous.phase !== 'gameOver', 'This game has already ended.');
  assert(action && typeof action === 'object', 'A game action is required.');
  const state: GameState = structuredClone(previous);
  const player = state.players[state.currentPlayer];
  // Points gained outside a player's turn are recognized as soon as that turn starts.
  checkVictory(state);
  if (state.winner !== null) return state;
  switch (action.type) {
    case 'BUILD': {
      assert(['road', 'settlement', 'city'].includes(action.kind), 'Choose a valid building.');
      assert(
        Number.isInteger(action.id) && legalBuilds(state, action.kind).includes(action.id),
        'You cannot build there. Check the cost, distance rule, and connection to your network.',
      );
      const setup = state.phase === 'setupSettlement' || state.phase === 'setupRoad';
      if (!setup && state.freeRoads === 0) pay(state, player, COSTS[action.kind]);
      if (action.kind === 'road') state.board.edges[action.id].owner = player.id;
      else state.board.vertices[action.id].building = { owner: player.id, type: action.kind };
      log(state, `${player.name} builds a ${action.kind}.`, player.id);
      if (state.phase === 'setupSettlement') {
        state.setupVertex = action.id;
        if (state.setupStep >= state.players.length) {
          for (const id of state.board.vertices[action.id].hexes) {
            const terrain = state.board.hexes[id].terrain;
            if (terrain !== 'desert' && state.bank[terrain] > 0) receive(state, player, terrain, 1);
          }
        }
        state.phase = 'setupRoad';
      } else if (state.phase === 'setupRoad') {
        state.setupStep++;
        state.setupVertex = null;
        if (state.setupStep === state.players.length * 2) {
          state.currentPlayer = state.primaryPlayer = 0;
          state.phase = 'roll';
          state.turn = 1;
          log(state, 'The settlements are founded. The first production roll awaits.');
        } else {
          state.currentPlayer =
            state.setupStep < state.players.length
              ? state.setupStep
              : 2 * state.players.length - state.setupStep - 1;
          state.phase = 'setupSettlement';
        }
      } else if (state.freeRoads > 0) {
        state.freeRoads--;
        if (state.freeRoads === 0 || legalBuilds(state, 'road').length === 0)
          finishFreeRoads(state);
      }
      refreshAwards(state);
      break;
    }
    case 'ROLL': {
      assert(
        state.phase === 'roll' && !state.paired,
        'You can roll only at the start of your primary turn.',
      );
      state.dice = [Math.floor(random(state) * 6) + 1, Math.floor(random(state) * 6) + 1];
      const value = state.dice[0] + state.dice[1];
      log(state, `${player.name} rolls ${value} (${state.dice[0]} + ${state.dice[1]}).`, player.id);
      state.resumePhase = 'action';
      if (value === 7) {
        state.discardQueue = state.players
          .filter((other) => resourceCount(other.resources) > 7)
          .map((other) => other.id);
        state.phase = state.discardQueue.length ? 'discard' : 'robber';
        log(
          state,
          state.discardQueue.length
            ? 'Players holding more than 7 resources must discard half, rounded down.'
            : 'Move the robber to a different hex.',
        );
      } else {
        distributeProduction(state, value);
        state.phase = 'action';
      }
      break;
    }
    case 'DISCARD': {
      assert(
        state.phase === 'discard' && state.discardQueue.includes(action.player),
        'That player does not need to discard.',
      );
      assert(validResources(action.resources), 'Choose whole, nonnegative resource quantities.');
      const discarder = state.players[action.player];
      const required = Math.floor(resourceCount(discarder.resources) / 2);
      assert(
        resourceCount(action.resources) === required,
        `You must discard exactly ${required} resource cards.`,
      );
      assert(
        canPay(discarder.resources, action.resources),
        'You cannot discard resources you do not have.',
      );
      pay(state, discarder, action.resources);
      state.discardQueue = state.discardQueue.filter((id) => id !== action.player);
      log(state, `${discarder.name} discards ${required} resource cards.`, discarder.id);
      if (!state.discardQueue.length) state.phase = 'robber';
      break;
    }
    case 'MOVE_ROBBER': {
      assert(state.phase === 'robber', 'The robber cannot move right now.');
      assert(
        Number.isInteger(action.hex) && state.board.hexes[action.hex],
        'Choose a hex on the island.',
      );
      assert(action.hex !== state.robberHex, 'Move the robber to a different hex.');
      state.robberHex = action.hex;
      state.stealTargets = [
        ...new Set(
          state.board.hexes[action.hex].vertices
            .map((id) => state.board.vertices[id].building?.owner)
            .filter(
              (id): id is number =>
                id !== undefined &&
                id !== player.id &&
                resourceCount(state.players[id].resources) > 0,
            ),
        ),
      ];
      log(state, `${player.name} moves the robber.`, player.id);
      state.phase = state.stealTargets.length ? 'steal' : state.resumePhase;
      break;
    }
    case 'STEAL': {
      assert(
        state.phase === 'steal' && state.stealTargets.includes(action.player),
        'Choose a player with resources and a building beside the robber.',
      );
      const victim = state.players[action.player];
      const total = resourceCount(victim.resources);
      let pick = Math.floor(random(state) * total);
      for (const resource of RESOURCES) {
        if (pick < victim.resources[resource]) {
          victim.resources[resource]--;
          player.resources[resource]++;
          break;
        }
        pick -= victim.resources[resource];
      }
      log(state, `${player.name} steals a resource card from ${victim.name}.`, player.id);
      state.stealTargets = [];
      state.phase = state.resumePhase;
      break;
    }
    case 'BANK_TRADE': {
      requireAction(state);
      assert(
        isResource(action.give) && isResource(action.receive),
        'Choose valid resources to trade.',
      );
      assert(action.give !== action.receive, 'Trade for a different resource.');
      const rate = tradeRate(state, player, action.give);
      assert(
        player.resources[action.give] >= rate,
        `You need ${rate} ${RESOURCE_NAMES[action.give].toLowerCase()} for this trade.`,
      );
      assert(
        state.bank[action.receive] > 0,
        `The supply has no ${RESOURCE_NAMES[action.receive].toLowerCase()} left.`,
      );
      pay(state, player, { ...emptyResources(), [action.give]: rate });
      receive(state, player, action.receive, 1);
      log(
        state,
        `${player.name} trades ${rate} ${RESOURCE_NAMES[action.give].toLowerCase()} for 1 ${RESOURCE_NAMES[action.receive].toLowerCase()}.`,
        player.id,
      );
      break;
    }
    case 'PLAYER_TRADE': {
      requireAction(state);
      assert(!state.paired, 'Player trading is unavailable during a paired action phase.');
      assert(
        Number.isInteger(action.player) &&
          state.players[action.player] &&
          action.player !== player.id,
        'Choose another player to trade with.',
      );
      assert(
        validResources(action.give) && validResources(action.receive),
        'Choose whole, nonnegative trade quantities.',
      );
      assert(
        resourceCount(action.give) > 0 && resourceCount(action.receive) > 0,
        'Each player must offer at least one resource.',
      );
      assert(
        RESOURCES.every((resource) => !(action.give[resource] > 0 && action.receive[resource] > 0)),
        'A resource cannot appear on both sides of a trade.',
      );
      const partner = state.players[action.player];
      assert(
        canPay(player.resources, action.give) && canPay(partner.resources, action.receive),
        'One of the players no longer has the offered resources.',
      );
      for (const resource of RESOURCES) {
        player.resources[resource] += action.receive[resource] - action.give[resource];
        partner.resources[resource] += action.give[resource] - action.receive[resource];
      }
      log(state, `${player.name} and ${partner.name} exchange resources.`, player.id);
      break;
    }
    case 'BUY_DEV': {
      requireAction(state);
      assert(state.deck.length > 0, 'There are no development cards left.');
      pay(state, player, COSTS.development);
      // The original deck size minus the remaining deck size is monotonic even after cards are played.
      const id = (state.config.mode === 'extension' ? 34 : 25) - state.deck.length;
      player.devCards.push({ id, type: state.deck.pop()!, boughtTurn: state.turn });
      log(state, `${player.name} buys a development card.`, player.id);
      break;
    }
    case 'PLAY_DEV': {
      assert(
        state.phase === 'roll' || state.phase === 'action',
        'Development cards can be played before rolling or during your action phase.',
      );
      assert(state.freeRoads === 0, 'Finish placing your free roads first.');
      const index = player.devCards.findIndex((card) => card.id === action.card);
      assert(index >= 0, 'That development card is not in your hand.');
      const card = player.devCards[index];
      assert(
        card.type !== 'victory',
        'Victory point cards are counted automatically and revealed when you win.',
      );
      assert(!state.devPlayed, 'You may play only one development card per turn.');
      assert(
        card.boughtTurn < state.turn,
        'You cannot play a development card in the turn you bought it.',
      );
      const priorPhase = state.phase;
      if (card.type === 'knight') {
        player.knights++;
        state.resumePhase = priorPhase;
        state.phase = 'robber';
        state.stealTargets = [];
        log(state, `${player.name} plays a Knight. Move the robber.`, player.id);
      } else if (card.type === 'roadBuilding') {
        assert(pieceCount(state, player.id, 'road') < 15, 'You have no road pieces left.');
        state.freeRoads = Math.min(2, 15 - pieceCount(state, player.id, 'road'));
        state.resumePhase = priorPhase;
        state.phase = 'action';
        assert(legalBuilds(state, 'road').length > 0, 'There is nowhere to place a road.');
        log(
          state,
          `${player.name} plays Road Building. Place up to ${state.freeRoads} free roads.`,
          player.id,
        );
      } else if (card.type === 'yearOfPlenty') {
        assert(
          Array.isArray(action.resources) &&
            action.resources.length === Math.min(2, resourceCount(state.bank)) &&
            action.resources.every(isResource),
          'Choose two available resources from the supply.',
        );
        const requested = emptyResources();
        for (const resource of action.resources) requested[resource]++;
        assert(canPay(state.bank, requested), 'The supply does not have those resources.');
        for (const resource of RESOURCES) receive(state, player, resource, requested[resource]);
        log(
          state,
          `${player.name} plays Year of Plenty and collects ${action.resources.length} resources.`,
          player.id,
        );
      } else if (card.type === 'monopoly') {
        assert(isResource(action.resource), 'Choose the resource to monopolize.');
        let total = 0;
        for (const other of state.players)
          if (other.id !== player.id) {
            total += other.resources[action.resource];
            other.resources[action.resource] = 0;
          }
        player.resources[action.resource] += total;
        log(
          state,
          `${player.name} plays Monopoly and collects ${total} ${RESOURCE_NAMES[action.resource].toLowerCase()}.`,
          player.id,
        );
      }
      player.devCards.splice(index, 1);
      state.devPlayed = true;
      refreshAwards(state);
      break;
    }
    case 'SKIP_FREE_ROADS': {
      assert(state.phase === 'action' && state.freeRoads > 0, 'There are no free roads to finish.');
      finishFreeRoads(state);
      log(state, `${player.name} finishes Road Building.`, player.id);
      break;
    }
    case 'END_TURN': {
      requireAction(state);
      checkVictory(state);
      if (state.winner === null) nextTurn(state);
      break;
    }
    default:
      throw new Error('Unknown game action.');
  }
  checkVictory(state);
  return state;
}
