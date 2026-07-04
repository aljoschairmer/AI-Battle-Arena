import type { GridVec } from "../types/protocol";

/** Grid geometry helpers. All operate on integer [col, row] grid coordinates. */

export function sub(a: GridVec, b: GridVec): GridVec {
  return [a[0] - b[0], a[1] - b[1]];
}

/** Euclidean distance — used for ranges/threat. */
export function dist(a: GridVec, b: GridVec): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
}

/** Chebyshev (king-move) distance — matches tile adjacency. */
export function chebyshev(a: GridVec, b: GridVec): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
}

/** The eight unit step directions, including diagonals. */
export const DIRECTIONS8: readonly GridVec[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/** Round a continuous direction vector to the nearest of the 8 unit steps. */
export function toUnitStep(v: GridVec): GridVec {
  const sx = Math.sign(v[0]);
  const sy = Math.sign(v[1]);
  return [sx, sy];
}

/** Unit step from `from` toward `to` (one of the 8 directions). */
export function stepToward(from: GridVec, to: GridVec): GridVec {
  return toUnitStep(sub(to, from));
}

/** Unit step directly away from `threat`. */
export function stepAwayFrom(self: GridVec, threat: GridVec): GridVec {
  return toUnitStep(sub(self, threat));
}

/** Perpendicular unit step relative to the line self->other (for strafing/dodging). */
export function perpendicularStep(self: GridVec, other: GridVec): GridVec {
  const d = sub(other, self);
  // rotate 90 degrees
  return toUnitStep([-d[1], d[0]]);
}

export function clampToGrid(p: GridVec, size: number): GridVec {
  return [
    Math.max(0, Math.min(size - 1, Math.round(p[0]))),
    Math.max(0, Math.min(size - 1, Math.round(p[1]))),
  ];
}

/** Move `steps` tiles from `p` in unit direction `dir`, clamped to the grid. */
export function project(p: GridVec, dir: GridVec, steps: number, size: number): GridVec {
  return clampToGrid([p[0] + dir[0] * steps, p[1] + dir[1] * steps], size);
}

