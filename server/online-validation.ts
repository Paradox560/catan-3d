import type { GameAction, Resource, Resources } from '../src/game/types';
export const RESOURCE_NAMES: Resource[] = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
export const emptyResources = (): Resources => ({ wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 });
export const total = (resources: Resources): number =>
  RESOURCE_NAMES.reduce((sum, key) => sum + resources[key], 0);
export class OnlineError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new OnlineError(message);
}
export function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'Invalid request.');
  return value as Record<string, unknown>;
}
export function integer(value: unknown, maximum = 500): number {
  assert(
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= maximum,
    'Invalid number.',
  );
  return value;
}
export function playerName(value: unknown): string {
  assert(typeof value === 'string', 'Enter your player name.');
  const result = value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 24);
  assert(result.length > 0, 'Enter your player name.');
  return result;
}
export function roomCode(value: unknown): string {
  assert(typeof value === 'string', 'Enter the six-character room code.');
  const code = value.trim().toUpperCase();
  assert(/^[A-Z2-9]{6}$/.test(code), 'Enter a valid six-character room code.');
  return code;
}
function resource(value: unknown): Resource {
  assert(RESOURCE_NAMES.includes(value as Resource), 'Invalid resource.');
  return value as Resource;
}
export function resources(value: unknown): Resources {
  const input = object(value);
  const output = emptyResources();
  for (const key of RESOURCE_NAMES) output[key] = integer(input[key], 100);
  assert(
    Object.keys(input).every((key) => RESOURCE_NAMES.includes(key as Resource)),
    'Invalid resource selection.',
  );
  return output;
}
export function parseAction(value: unknown): GameAction {
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
      throw new OnlineError('Player trades require the other player to accept the offer.');
    default:
      throw new OnlineError('Unknown game action.');
  }
}
