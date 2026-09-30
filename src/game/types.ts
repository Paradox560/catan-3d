export type Resource = 'wood' | 'brick' | 'sheep' | 'wheat' | 'ore';
export type Resources = Record<Resource, number>;
export type Terrain = Resource | 'desert';
export type DevType = 'knight' | 'victory' | 'roadBuilding' | 'yearOfPlenty' | 'monopoly';
export type Phase =
  'setupSettlement' | 'setupRoad' | 'roll' | 'action' | 'discard' | 'robber' | 'steal' | 'gameOver';
export type BuildKind = 'road' | 'settlement' | 'city';
export interface Hex {
  id: number;
  q: number;
  r: number;
  x: number;
  z: number;
  terrain: Terrain;
  number: number;
  vertices: number[];
}
export interface Vertex {
  id: number;
  x: number;
  z: number;
  hexes: number[];
  edges: number[];
  building: { owner: number; type: 'settlement' | 'city' } | null;
  port?: Resource | 'any';
}
export interface Edge {
  id: number;
  a: number;
  b: number;
  owner: number | null;
}
export interface Port {
  id: number;
  vertices: number[];
  type: Resource | 'any';
  x: number;
  z: number;
}
export interface Board {
  hexes: Hex[];
  vertices: Vertex[];
  edges: Edge[];
  ports: Port[];
}
export interface Player {
  id: number;
  name: string;
  color: string;
  resources: Resources;
  devCards: { id: number; type: DevType; boughtTurn: number }[];
  knights: number;
  roadLength: number;
}
export interface GameConfig {
  mode: 'standard' | 'extension';
  names: string[];
  seed: string;
  targetPoints: number;
}
export interface GameState {
  version: 1;
  config: GameConfig;
  board: Board;
  players: Player[];
  bank: Resources;
  deck: DevType[];
  currentPlayer: number;
  primaryPlayer: number;
  paired: boolean;
  turn: number;
  round: number;
  phase: Phase;
  setupStep: number;
  setupVertex: number | null;
  dice: [number, number] | null;
  robberHex: number;
  discardQueue: number[];
  stealTargets: number[];
  resumePhase: 'roll' | 'action';
  freeRoads: number;
  devPlayed: boolean;
  longestRoad: number | null;
  largestArmy: number | null;
  winner: number | null;
  log: { id: number; text: string; player?: number }[];
  rng: number;
}
export type GameAction =
  | { type: 'BUILD'; kind: BuildKind; id: number }
  | { type: 'ROLL' }
  | { type: 'END_TURN' }
  | { type: 'DISCARD'; player: number; resources: Resources }
  | { type: 'MOVE_ROBBER'; hex: number }
  | { type: 'STEAL'; player: number }
  | { type: 'BANK_TRADE'; give: Resource; receive: Resource }
  | { type: 'PLAYER_TRADE'; player: number; give: Resources; receive: Resources }
  | { type: 'BUY_DEV' }
  | { type: 'PLAY_DEV'; card: number; resources?: Resource[]; resource?: Resource }
  | { type: 'SKIP_FREE_ROADS' };
