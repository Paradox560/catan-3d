export interface Breakdown {
  settlements: number;
  cities: number;
  victoryCards: number;
  longestRoad: boolean;
  largestArmy: boolean;
  other: number;
}

export interface GameResult {
  playerId: string;
  breakdown: Breakdown;
}

export interface RankedPlayer {
  id: string;
  name: string;
}

export interface RecordedGame {
  id: string;
  date: string;
  notes: string;
  results: GameResult[];
}

export interface RankingsData {
  version: 1;
  revision: number;
  players: RankedPlayer[];
  games: RecordedGame[];
}

export interface Standing {
  player: RankedPlayer;
  rank: number | null;
  gamesPlayed: number;
  totalVP: number;
  averageVP: number;
  bestVP: number;
  lastPlayed: string | null;
}

export function emptyRankings(): RankingsData {
  return { version: 1, revision: 0, players: [], games: [] };
}

export function emptyBreakdown(): Breakdown {
  return {
    settlements: 0,
    cities: 0,
    victoryCards: 0,
    longestRoad: false,
    largestArmy: false,
    other: 0,
  };
}

export function totalVP(breakdown: Breakdown): number {
  return (
    breakdown.settlements +
    breakdown.cities * 2 +
    breakdown.victoryCards +
    (breakdown.longestRoad ? 2 : 0) +
    (breakdown.largestArmy ? 2 : 0) +
    breakdown.other
  );
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function boundedInteger(value: unknown, label: string, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${label} must be a whole number from 0 to ${maximum}.`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be true or false.`);
  return value;
}

function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) {
    throw new Error(`${label} must contain 1–80 letters, numbers, underscores, or hyphens.`);
  }
  return value;
}

function trimmedText(value: unknown, label: string, minimum: number, maximum: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be text.`);
  const text = value.trim();
  if (text.length < minimum || text.length > maximum) {
    throw new Error(`${label} must contain ${minimum}–${maximum} characters.`);
  }
  return text;
}

function date(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} must use YYYY-MM-DD.`);
  }
  const [year, month, day] = value.split('-').map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]) {
    throw new Error(`${label} must be a real calendar date.`);
  }
  return value;
}

function breakdown(value: unknown, label: string): Breakdown {
  const fields = record(value, label);
  return {
    settlements: boundedInteger(fields.settlements, `${label}: settlements`, 5),
    cities: boundedInteger(fields.cities, `${label}: cities`, 4),
    victoryCards: boundedInteger(fields.victoryCards, `${label}: victory point cards`, 6),
    longestRoad: boolean(fields.longestRoad, `${label}: longest road`),
    largestArmy: boolean(fields.largestArmy, `${label}: largest army`),
    other: boundedInteger(fields.other, `${label}: other victory points`, 50),
  };
}

/** Validate untrusted JSON and return an independent, normalized data object. */
export function validateRankings(input: unknown): RankingsData {
  const source = record(input, 'Rankings');
  if (source.version !== 1) throw new Error('Unsupported rankings version. Expected version 1.');
  const revision = boundedInteger(source.revision, 'Revision', Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(source.players) || source.players.length > 500) {
    throw new Error('Players must be a list with no more than 500 entries.');
  }
  if (!Array.isArray(source.games) || source.games.length > 2000) {
    throw new Error('Games must be a list with no more than 2,000 entries.');
  }

  const playerIds = new Set<string>();
  const playerNames = new Set<string>();
  const players: RankedPlayer[] = source.players.map((value, index) => {
    const label = `Player ${index + 1}`;
    const fields = record(value, label);
    const playerId = id(fields.id, `${label} ID`);
    const name = trimmedText(fields.name, `${label} name`, 1, 40);
    if (playerIds.has(playerId)) throw new Error(`Duplicate player ID: ${playerId}.`);
    if (playerNames.has(name.toLowerCase())) throw new Error(`Duplicate player name: ${name}.`);
    playerIds.add(playerId);
    playerNames.add(name.toLowerCase());
    return { id: playerId, name };
  });

  const gameIds = new Set<string>();
  const games: RecordedGame[] = source.games.map((value, index) => {
    const label = `Game ${index + 1}`;
    const fields = record(value, label);
    const gameId = id(fields.id, `${label} ID`);
    if (gameIds.has(gameId)) throw new Error(`Duplicate game ID: ${gameId}.`);
    gameIds.add(gameId);
    const gameDate = date(fields.date, `${label} date`);
    const notes = trimmedText(fields.notes, `${label} notes`, 0, 2000);
    if (!Array.isArray(fields.results) || fields.results.length < 2 || fields.results.length > 6) {
      throw new Error(`${label} must have results for 2–6 distinct players.`);
    }
    const resultIds = new Set<string>();
    const results: GameResult[] = fields.results.map((result, resultIndex) => {
      const resultLabel = `${label}, result ${resultIndex + 1}`;
      const resultFields = record(result, resultLabel);
      const playerId = id(resultFields.playerId, `${resultLabel} player ID`);
      if (!playerIds.has(playerId)) throw new Error(`${resultLabel} refers to an unknown player.`);
      if (resultIds.has(playerId))
        throw new Error(`${label} contains duplicate results for a player.`);
      resultIds.add(playerId);
      return { playerId, breakdown: breakdown(resultFields.breakdown, resultLabel) };
    });
    return { id: gameId, date: gameDate, notes, results };
  });
  return { version: 1, revision, players, games };
}

/** Rank by accumulated victory points. Names only determine display order within a tie. */
export function buildStandings(data: RankingsData): Standing[] {
  const standings = new Map<string, Standing>(
    data.players.map((player) => [
      player.id,
      { player, rank: null, gamesPlayed: 0, totalVP: 0, averageVP: 0, bestVP: 0, lastPlayed: null },
    ]),
  );
  for (const game of data.games) {
    for (const result of game.results) {
      const standing = standings.get(result.playerId);
      if (!standing) continue;
      const points = totalVP(result.breakdown);
      standing.gamesPlayed += 1;
      standing.totalVP += points;
      standing.bestVP = Math.max(standing.bestVP, points);
      if (standing.lastPlayed === null || game.date > standing.lastPlayed) {
        standing.lastPlayed = game.date;
      }
    }
  }
  const ordered = [...standings.values()].sort(
    (a, b) =>
      Number(b.gamesPlayed > 0) - Number(a.gamesPlayed > 0) ||
      b.totalVP - a.totalVP ||
      a.player.name.localeCompare(b.player.name) ||
      a.player.id.localeCompare(b.player.id),
  );
  let previousPoints: number | null = null;
  let rank = 0;
  for (const [index, standing] of ordered.entries()) {
    if (standing.gamesPlayed === 0) continue;
    if (standing.totalVP !== previousPoints) rank = index + 1;
    standing.rank = rank;
    standing.averageVP = standing.totalVP / standing.gamesPlayed;
    previousPoints = standing.totalVP;
  }
  return ordered;
}
