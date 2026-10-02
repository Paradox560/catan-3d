import { describe, expect, it } from 'vitest';
import {
  buildStandings,
  emptyBreakdown,
  emptyRankings,
  filterRankingsByDate,
  totalVP,
  validateRankings,
} from './model';
import type { Breakdown, RankingsData } from './model';

function fixture(): RankingsData {
  return {
    version: 1,
    revision: 7,
    players: [
      { id: 'player-ada', name: 'Ada' },
      { id: 'player-bea', name: 'Bea' },
      { id: 'player-cam', name: 'Cam' },
      { id: 'player-dan', name: 'Dan' },
    ],
    games: [
      {
        id: 'game-one',
        date: '2026-09-29',
        notes: 'First game',
        results: [
          {
            playerId: 'player-ada',
            breakdown: { ...emptyBreakdown(), settlements: 2, cities: 3, longestRoad: true },
          },
          {
            playerId: 'player-bea',
            breakdown: { ...emptyBreakdown(), settlements: 3, cities: 2 },
          },
          { playerId: 'player-cam', breakdown: { ...emptyBreakdown(), cities: 3 } },
        ],
      },
      {
        id: 'game-two',
        date: '2026-10-01',
        notes: '',
        results: [
          { playerId: 'player-ada', breakdown: { ...emptyBreakdown(), settlements: 5 } },
          {
            playerId: 'player-bea',
            breakdown: { ...emptyBreakdown(), cities: 4, largestArmy: true },
          },
        ],
      },
    ],
  };
}

describe('victory point standings', () => {
  it('counts settlement pieces as one, city pieces as two, and awards as two each', () => {
    expect(totalVP(emptyBreakdown())).toBe(0);
    expect(
      totalVP({
        settlements: 3,
        cities: 2,
        victoryCards: 1,
        longestRoad: true,
        largestArmy: true,
        other: 4,
      }),
    ).toBe(16);
  });

  it('ranks by total VP, including game count, mean, wins and latest calendar date', () => {
    const data = fixture();
    // Input order has no bearing on the latest date or the rankings.
    data.games.reverse();
    const standings = buildStandings(data);
    expect(standings.map((standing) => standing.player.name)).toEqual(['Bea', 'Ada', 'Cam', 'Dan']);
    expect(standings.map(({ player: _player, ...standing }) => standing)).toEqual([
      {
        rank: 1,
        gamesPlayed: 2,
        totalVP: 17,
        averageVP: 8.5,
        wins: 1,
        lastPlayed: '2026-10-01',
      },
      {
        rank: 2,
        gamesPlayed: 2,
        totalVP: 15,
        averageVP: 7.5,
        wins: 1,
        lastPlayed: '2026-10-01',
      },
      { rank: 3, gamesPlayed: 1, totalVP: 6, averageVP: 6, wins: 0, lastPlayed: '2026-09-29' },
      { rank: null, gamesPlayed: 0, totalVP: 0, averageVP: 0, wins: 0, lastPlayed: null },
    ]);
  });

  it('recalculates after a score correction, a deleted game, and a player rename', () => {
    const data = fixture();
    data.games[1].results[0].breakdown.other = 5;
    expect(buildStandings(data)[0]).toMatchObject({ player: { id: 'player-ada' }, totalVP: 20 });
    data.players[0].name = 'Adelaide';
    expect(buildStandings(data)[0]).toMatchObject({
      player: { id: 'player-ada', name: 'Adelaide' },
      gamesPlayed: 2,
      totalVP: 20,
      wins: 2,
    });
    data.games.splice(0, 1);
    expect(
      buildStandings(data).find((standing) => standing.player.id === 'player-cam'),
    ).toMatchObject({
      rank: null,
      gamesPlayed: 0,
      totalVP: 0,
      lastPlayed: null,
    });
    expect(
      buildStandings(data).find((standing) => standing.player.id === 'player-ada'),
    ).toMatchObject({
      totalVP: 10,
      gamesPlayed: 1,
      wins: 1,
    });
  });

  it('shares wins between tied positive leaders and excludes all-zero games', () => {
    const data = fixture();
    data.games[0].results[1].breakdown.other = 3;
    expect(buildStandings(data).map((entry) => [entry.player.name, entry.wins])).toEqual([
      ['Bea', 2],
      ['Ada', 1],
      ['Cam', 0],
      ['Dan', 0],
    ]);
    data.games.forEach((game) =>
      game.results.forEach((result) => (result.breakdown = emptyBreakdown())),
    );
    expect(buildStandings(data).every((entry) => entry.wins === 0)).toBe(true);
  });

  it('gives tied totals the same competition rank, independently of average or games played', () => {
    const data = fixture();
    data.games[1].results[0].breakdown.other = 2;
    const standings = buildStandings(data);
    expect(standings.map((standing) => [standing.player.name, standing.rank])).toEqual([
      ['Ada', 1],
      ['Bea', 1],
      ['Cam', 3],
      ['Dan', null],
    ]);
    data.games[0].results[2].breakdown.other = 11;
    expect(
      buildStandings(data)
        .slice(0, 3)
        .map((standing) => standing.rank),
    ).toEqual([1, 1, 1]);
  });

  it('ranks a recorded zero-point result ahead of a player who has never played', () => {
    const data = fixture();
    data.games = [data.games[0]];
    data.games[0].results.forEach((result) => (result.breakdown = emptyBreakdown()));
    data.players[3].name = 'Aaron';
    expect(buildStandings(data).map((standing) => [standing.player.name, standing.rank])).toEqual([
      ['Ada', 1],
      ['Bea', 1],
      ['Cam', 1],
      ['Aaron', null],
    ]);
  });

  it('returns independent empty structures and never mutates the source when computing standings', () => {
    const first = emptyRankings();
    first.players.push({ id: 'a', name: 'A' });
    expect(emptyRankings()).toEqual({ version: 1, revision: 0, players: [], games: [] });
    expect(buildStandings(emptyRankings())).toEqual([]);
    const data = fixture();
    const before = JSON.stringify(data);
    buildStandings(data);
    expect(JSON.stringify(data)).toBe(before);
  });
});

describe('date range views', () => {
  it('includes both boundary dates and permits either open end', () => {
    const data = fixture();
    expect(filterRankingsByDate(data, { from: '2026-09-29', to: '2026-10-01' }).games).toEqual(
      data.games,
    );
    expect(filterRankingsByDate(data, { from: '2026-10-01' }).games.map((game) => game.id)).toEqual(
      ['game-two'],
    );
    expect(filterRankingsByDate(data, { to: '2026-09-29' }).games.map((game) => game.id)).toEqual([
      'game-one',
    ]);
    expect(
      filterRankingsByDate(data, { from: '2026-10-01', to: '2026-10-01' }).games.map(
        (game) => game.id,
      ),
    ).toEqual(['game-two']);
    expect(filterRankingsByDate(data, { from: '', to: '' }).games).toEqual(data.games);
  });

  it('recomputes scores and wins while preserving the complete saved ledger and revision', () => {
    const data = fixture();
    const before = structuredClone(data);
    const filtered = filterRankingsByDate(data, { to: '2026-09-29' });
    expect(
      buildStandings(filtered).map((entry) => [entry.player.name, entry.totalVP, entry.wins]),
    ).toEqual([
      ['Ada', 10, 1],
      ['Bea', 7, 0],
      ['Cam', 6, 0],
      ['Dan', 0, 0],
    ]);
    expect(filtered.revision).toBe(data.revision);
    expect(filtered.players).toEqual(data.players);
    filtered.games.pop();
    expect(data).toEqual(before);
    expect(filterRankingsByDate(data, { from: '2027-01-01' }).games).toEqual([]);
  });

  it('rejects reversed and impossible calendar date ranges', () => {
    const data = fixture();
    expect(() => filterRankingsByDate(data, { from: '2026-10-01', to: '2026-09-29' })).toThrow(
      'From date must be on or before To date.',
    );
    for (const from of ['2026-02-29', '2026-13-01', 'October 1', '0000-01-01']) {
      expect(() => filterRankingsByDate(data, { from })).toThrow(/From date/);
    }
    expect(() => filterRankingsByDate(data, { to: '2026-02-30' })).toThrow(/To date/);
  });
});

describe('rankings validation', () => {
  it('normalizes whitespace without mutating or sharing nested storage with input', () => {
    const input = fixture();
    input.players[0].name = '  Ada  ';
    input.games[0].notes = '  A memorable\ngame.  ';
    const normalized = validateRankings(input);
    expect(normalized.players[0].name).toBe('Ada');
    expect(normalized.games[0].notes).toBe('A memorable\ngame.');
    normalized.games[0].results[0].breakdown.settlements = 0;
    expect(input.players[0].name).toBe('  Ada  ');
    expect(input.games[0].results[0].breakdown.settlements).toBe(2);
    expect(validateRankings(emptyRankings())).toEqual(emptyRankings());
  });

  it.each(['2024-02-29', '2000-02-29', '2026-04-30', '0001-01-01', '9999-12-31'])(
    'accepts the real calendar date %s',
    (date) => {
      const data = fixture();
      data.games[0].date = date;
      expect(validateRankings(data).games[0].date).toBe(date);
    },
  );

  it.each([
    '2026-02-29',
    '1900-02-29',
    '2100-02-29',
    '2026-04-31',
    '2026-13-01',
    '2026-00-01',
    '2026-01-00',
    '0000-01-01',
    '2026-1-01',
    '2026-01-01T00:00:00Z',
    '',
  ])('rejects invalid date %s', (date) => {
    const data = fixture();
    data.games[0].date = date;
    expect(() => validateRankings(data)).toThrow(/date/);
  });

  it('rejects duplicate player IDs, names, game IDs and repeated game participants', () => {
    let data = fixture();
    data.players[1].id = data.players[0].id;
    expect(() => validateRankings(data)).toThrow(/Duplicate player ID/);
    data = fixture();
    data.players[1].name = ' aDA ';
    expect(() => validateRankings(data)).toThrow(/Duplicate player name/);
    data = fixture();
    data.games[1].id = data.games[0].id;
    expect(() => validateRankings(data)).toThrow(/Duplicate game ID/);
    data = fixture();
    data.games[0].results[1].playerId = data.games[0].results[0].playerId;
    expect(() => validateRankings(data)).toThrow(/duplicate results/);
  });

  it('rejects unknown references and games with fewer than two or more than six players', () => {
    let data = fixture();
    data.games[0].results[0].playerId = 'missing';
    expect(() => validateRankings(data)).toThrow(/unknown player/);
    data = fixture();
    data.games[0].results = data.games[0].results.slice(0, 1);
    expect(() => validateRankings(data)).toThrow(/2–6 distinct players/);
    data = fixture();
    data.games[0].results = Array.from({ length: 7 }, () => data.games[0].results[0]);
    expect(() => validateRankings(data)).toThrow(/2–6 distinct players/);
  });

  it('accepts a six-player game and full piece-count limits', () => {
    const data = fixture();
    data.players.push({ id: 'player-e', name: 'Eve' }, { id: 'player-f', name: 'Finn' });
    data.games[0].results = data.players.map((player) => ({
      playerId: player.id,
      breakdown: {
        settlements: 5,
        cities: 4,
        victoryCards: 6,
        longestRoad: true,
        largestArmy: true,
        other: 50,
      },
    }));
    expect(validateRankings(data).games[0].results).toHaveLength(6);
  });

  it.each([
    ['settlements', -1],
    ['settlements', 6],
    ['settlements', 1.5],
    ['settlements', '2'],
    ['cities', 5],
    ['victoryCards', 7],
    ['other', 51],
    ['other', Infinity],
    ['other', NaN],
    ['other', null],
    ['longestRoad', 1],
    ['largestArmy', 'false'],
    ['largestArmy', undefined],
  ])('rejects malformed breakdown field %s = %s', (field, value) => {
    const data = fixture();
    const breakdown = data.games[0].results[0].breakdown as unknown as Record<string, unknown>;
    breakdown[field as keyof Breakdown] = value;
    expect(() => validateRankings(data)).toThrow(/must be/);
  });

  it.each([null, [], 1, 'rankings', {}, { version: 2 }, { ...emptyRankings(), players: {} }])(
    'rejects malformed top-level data %#',
    (value) => expect(() => validateRankings(value)).toThrow(),
  );

  it.each([-1, 1.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid revision %s',
    (revision) =>
      expect(() => validateRankings({ ...emptyRankings(), revision })).toThrow(/Revision/),
  );

  it('enforces bounded safe IDs, names, notes and collection sizes', () => {
    let data = fixture();
    data.players[0].id = '../path';
    expect(() => validateRankings(data)).toThrow(/ID/);
    data = fixture();
    data.games[0].id = 'a'.repeat(81);
    expect(() => validateRankings(data)).toThrow(/ID/);
    data = fixture();
    data.players[0].name = ' ';
    expect(() => validateRankings(data)).toThrow(/name/);
    data.players[0].name = 'a'.repeat(41);
    expect(() => validateRankings(data)).toThrow(/name/);
    data = fixture();
    data.games[0].notes = 'a'.repeat(2001);
    expect(() => validateRankings(data)).toThrow(/notes/);
    data = fixture();
    data.players = Array.from({ length: 501 }, () => data.players[0]);
    expect(() => validateRankings(data)).toThrow(/500/);
    data = fixture();
    data.games = Array.from({ length: 2001 }, () => data.games[0]);
    expect(() => validateRankings(data)).toThrow(/2,000/);
  });
});
