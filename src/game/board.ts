import type { Board, GameConfig, Resource, Terrain } from './types.js';

/** Fisher–Yates; the injected source makes board generation replayable on any host. */
export function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function createBoard(mode: GameConfig['mode'], random: () => number): Board {
  const expanded = mode === 'extension';
  const radius = expanded ? 3 : 2;
  const board: Board = { hexes: [], vertices: [], edges: [], ports: [] };
  const terrain: Terrain[] = [];
  const counts: Record<Terrain, number> = expanded
    ? { wood: 6, brick: 5, sheep: 6, wheat: 6, ore: 5, desert: 2 }
    : { wood: 4, brick: 3, sheep: 4, wheat: 4, ore: 3, desert: 1 };
  for (const [kind, count] of Object.entries(counts)) {
    terrain.push(...Array<Terrain>(count).fill(kind as Terrain));
  }
  const terrains = shuffle(terrain, random);
  const vertexMap = new Map<string, number>();
  const edgeMap = new Map<string, number>();
  const edgeHexCount = new Map<number, number>();
  for (let r = -radius; r <= radius; r++) {
    const minQ = Math.max(-radius, -r - radius);
    const maxQ = Math.min(expanded ? 2 : radius, (expanded ? 2 : radius) - r);
    for (let q = minQ; q <= maxQ; q++) {
      const id = board.hexes.length;
      const x = Math.sqrt(3) * (q + r / 2 + (expanded ? 0.5 : 0));
      const z = 1.5 * r;
      const vertices: number[] = [];
      for (let corner = 0; corner < 6; corner++) {
        const angle = (Math.PI / 180) * (60 * corner - 30);
        const vx = x + Math.cos(angle);
        const vz = z + Math.sin(angle);
        const key = `${Math.round(vx * 1e5)},${Math.round(vz * 1e5)}`;
        let vertex = vertexMap.get(key);
        if (vertex === undefined) {
          vertex = board.vertices.length;
          vertexMap.set(key, vertex);
          board.vertices.push({ id: vertex, x: vx, z: vz, hexes: [], edges: [], building: null });
        }
        board.vertices[vertex].hexes.push(id);
        vertices.push(vertex);
      }
      for (let corner = 0; corner < 6; corner++) {
        const a = vertices[corner];
        const b = vertices[(corner + 1) % 6];
        const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
        let edge = edgeMap.get(key);
        if (edge === undefined) {
          edge = board.edges.length;
          edgeMap.set(key, edge);
          board.edges.push({ id: edge, a, b, owner: null });
          board.vertices[a].edges.push(edge);
          board.vertices[b].edges.push(edge);
        }
        edgeHexCount.set(edge, (edgeHexCount.get(edge) ?? 0) + 1);
      }
      board.hexes.push({ id, q, r, x, z, terrain: terrains[id], number: 0, vertices });
    }
  }

  // Place the high-probability numbers on an independent set of land hexes.
  // Backtracking avoids relying on an unbounded shuffle-until-lucky loop.
  const land = shuffle(
    board.hexes.filter((h) => h.terrain !== 'desert').map((h) => h.id),
    random,
  );
  const adjacent = (a: number, b: number) => {
    const first = board.hexes[a],
      second = board.hexes[b];
    const dq = first.q - second.q,
      dr = first.r - second.r;
    return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr)) === 1;
  };
  const redCount = expanded ? 6 : 4;
  const chooseRed = (available: number[], chosen: number[]): number[] | null => {
    if (chosen.length === redCount) return chosen;
    if (chosen.length + available.length < redCount) return null;
    for (let i = 0; i < available.length; i++) {
      const id = available[i];
      const result = chooseRed(
        available.slice(i + 1).filter((other) => !adjacent(id, other)),
        [...chosen, id],
      );
      if (result) return result;
    }
    return null;
  };
  const red = chooseRed(land, []);
  if (!red) throw new Error('Could not generate a balanced number layout.');
  const redNumbers = shuffle(
    Array<number>(redCount / 2)
      .fill(6)
      .concat(Array<number>(redCount / 2).fill(8)),
    random,
  );
  red.forEach((id, i) => {
    board.hexes[id].number = redNumbers[i];
  });
  const ordinary: number[] = [];
  for (const value of [2, 3, 4, 5, 9, 10, 11, 12]) {
    ordinary.push(
      ...Array<number>(value === 2 || value === 12 ? (expanded ? 2 : 1) : expanded ? 3 : 2).fill(
        value,
      ),
    );
  }
  const numbers = shuffle(ordinary, random);
  land
    .filter((id) => !red.includes(id))
    .forEach((id, i) => {
      board.hexes[id].number = numbers[i];
    });

  // Traverse the actual coastline so that every port occupies one coastal edge.
  const coast = board.edges.filter((edge) => edgeHexCount.get(edge.id) === 1);
  const ordered: number[] = [];
  let nextVertex = coast[0].a;
  let previousEdge = -1;
  do {
    const edge = coast.find(
      (e) => e.id !== previousEdge && (e.a === nextVertex || e.b === nextVertex),
    );
    if (!edge || ordered.includes(edge.id)) break;
    ordered.push(edge.id);
    nextVertex = edge.a === nextVertex ? edge.b : edge.a;
    previousEdge = edge.id;
  } while (ordered.length < coast.length);
  const portTypes: (Resource | 'any')[] = [
    'wood',
    'brick',
    'sheep',
    'wheat',
    'ore',
    'any',
    'any',
    'any',
    'any',
  ];
  if (expanded) portTypes.push('sheep', 'any');
  const ports = shuffle(portTypes, random);
  const offset = Math.floor(random() * ordered.length);
  ports.forEach((type, i) => {
    const edge =
      board.edges[
        ordered[(offset + Math.floor((i * ordered.length) / ports.length)) % ordered.length]
      ];
    const a = board.vertices[edge.a],
      b = board.vertices[edge.b];
    a.port = type;
    b.port = type;
    const mx = (a.x + b.x) / 2,
      mz = (a.z + b.z) / 2;
    const length = Math.hypot(mx, mz) || 1;
    board.ports.push({
      id: i,
      type,
      vertices: [a.id, b.id],
      x: mx + (mx / length) * 0.65,
      z: mz + (mz / length) * 0.65,
    });
  });
  return board;
}
