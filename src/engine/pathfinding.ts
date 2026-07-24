import type { GridVec } from "../types/protocol";

/**
 * Lightweight A* on the 100x100 grid with 8-directional movement.
 *
 * Performance notes:
 *  - The server already offers `move_to` with server-side A*, so we usually defer
 *    to it. This local planner is for cases where we need the *next step only*
 *    while accounting for known local blockers (walls, void, burn fields, mines)
 *    that we want to avoid this tick without a round trip.
 *  - We cap expansion so a pathological call can never blow the tick budget.
 */

export type Passable = (col: number, row: number) => boolean;

/**
 * Optional additive per-tile entry cost for weighted A* (threat-aware
 * routing). Must be >= 0 everywhere or the octile heuristic stops being
 * admissible and paths silently degrade. With costs the search behaves more
 * like Dijkstra inside high-danger pockets — still fine, the expansion cap
 * bounds the worst case and callers pass a small window anyway.
 */
export type TileCost = (col: number, row: number) => number;

const MAX_EXPANSIONS = 1500;

interface Node {
  col: number;
  row: number;
  g: number;
  f: number;
  parent: Node | null;
}

const NEIGHBORS: ReadonlyArray<[number, number, number]> = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, 1.4142],
  [1, -1, 1.4142],
  [-1, 1, 1.4142],
  [-1, -1, 1.4142],
];

/**
 * Returns the full path from `start` to `goal` (inclusive) or null if none was
 * found within the expansion budget. Octile-distance heuristic.
 */
export function findPath(
  start: GridVec,
  goal: GridVec,
  size: number,
  passable: Passable,
  tileCost?: TileCost,
): GridVec[] | null {
  if (start[0] === goal[0] && start[1] === goal[1]) return [start];

  // Tile key derived from the actual grid size (cols are 0..size-1), so a
  // bigger arena can never alias two tiles onto one key.
  const key = (col: number, row: number): number => row * size + col;

  const open: Node[] = [];
  const gScore = new Map<number, number>();
  const closed = new Set<number>();

  const startNode: Node = { col: start[0], row: start[1], g: 0, f: octile(start, goal), parent: null };
  open.push(startNode);
  gScore.set(key(start[0], start[1]), 0);

  let expansions = 0;
  while (open.length > 0) {
    if (expansions++ > MAX_EXPANSIONS) return null;

    // Pop lowest f. Linear scan is fine for our small, capped frontiers.
    let bestIdx = 0;
    for (let i = 1; i < open.length; i++) {
      const oi = open[i]!;
      const ob = open[bestIdx]!;
      if (oi.f < ob.f) bestIdx = i;
    }
    const current = open.splice(bestIdx, 1)[0]!;
    const ck = key(current.col, current.row);
    if (closed.has(ck)) continue;
    closed.add(ck);

    if (current.col === goal[0] && current.row === goal[1]) {
      return reconstruct(current);
    }

    for (const [dc, dr, cost] of NEIGHBORS) {
      const nc = current.col + dc;
      const nr = current.row + dr;
      if (nc < 0 || nr < 0 || nc >= size || nr >= size) continue;
      if (!passable(nc, nr)) continue;
      // Prevent corner-cutting through wall diagonals.
      if (dc !== 0 && dr !== 0) {
        if (!passable(current.col + dc, current.row) && !passable(current.col, current.row + dr)) {
          continue;
        }
      }
      const nk = key(nc, nr);
      if (closed.has(nk)) continue;
      const tentativeG = current.g + cost + (tileCost ? Math.max(0, tileCost(nc, nr)) : 0);
      const prevG = gScore.get(nk);
      if (prevG !== undefined && tentativeG >= prevG) continue;
      gScore.set(nk, tentativeG);
      open.push({
        col: nc,
        row: nr,
        g: tentativeG,
        f: tentativeG + octile([nc, nr], goal),
        parent: current,
      });
    }
  }
  return null;
}

/** Just the next tile to step onto toward goal, or null. */
export function nextStep(
  start: GridVec,
  goal: GridVec,
  size: number,
  passable: Passable,
  tileCost?: TileCost,
): GridVec | null {
  const path = findPath(start, goal, size, passable, tileCost);
  if (!path || path.length < 2) return null;
  return path[1]!;
}

function octile(a: GridVec, b: GridVec): number {
  const dx = Math.abs(a[0] - b[0]);
  const dy = Math.abs(a[1] - b[1]);
  return dx + dy + (1.4142 - 2) * Math.min(dx, dy);
}

function reconstruct(node: Node): GridVec[] {
  const path: GridVec[] = [];
  let n: Node | null = node;
  while (n) {
    path.push([n.col, n.row]);
    n = n.parent;
  }
  return path.reverse();
}
