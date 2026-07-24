import { describe, expect, it } from "vitest";
import { findPath, nextStep } from "../src/engine/pathfinding";
import type { GridVec } from "../src/types/protocol";

const open = (): boolean => true;

describe("findPath", () => {
  it("returns the single-tile path when start equals goal", () => {
    expect(findPath([5, 5], [5, 5], 10, open)).toEqual([[5, 5]]);
  });

  it("finds a straight path on open ground (inclusive of both ends)", () => {
    const path = findPath([0, 0], [3, 0], 10, open);
    expect(path).not.toBeNull();
    expect(path![0]).toEqual([0, 0]);
    expect(path![path!.length - 1]).toEqual([3, 0]);
    expect(path!.length).toBe(4);
  });

  it("uses diagonals (octile), not manhattan detours", () => {
    const path = findPath([0, 0], [3, 3], 10, open);
    expect(path).not.toBeNull();
    expect(path!.length).toBe(4); // 3 diagonal steps + start
  });

  it("routes around a wall", () => {
    // Vertical wall at col 2, gap at row 4.
    const passable = (c: number, r: number): boolean => c !== 2 || r === 4;
    const path = findPath([0, 0], [4, 0], 8, passable);
    expect(path).not.toBeNull();
    expect(path!.some(([c, r]) => c === 2 && r === 4)).toBe(true);
    for (const [c, r] of path!) expect(passable(c, r)).toBe(true);
  });

  it("returns null when the goal is walled off", () => {
    const passable = (c: number): boolean => c !== 2; // full wall, no gap
    expect(findPath([0, 0], [4, 0], 8, passable)).toBeNull();
  });

  it("never cuts a corner between two walls", () => {
    // Both orthogonal neighbours of the diagonal move are blocked: the only
    // way out of [0,0] would be squeezing between the two walls — forbidden.
    const blocked = new Set(["1,0", "0,1"]);
    const passable = (c: number, r: number): boolean => !blocked.has(`${c},${r}`);
    expect(findPath([0, 0], [1, 1], 3, passable)).toBeNull();
    // With one of the walls removed, the same diagonal is legal again.
    const oneWall = (c: number, r: number): boolean => !(c === 1 && r === 0);
    const path = findPath([0, 0], [1, 1], 3, oneWall);
    expect(path).not.toBeNull();
    expect(path!.length).toBe(2);
  });

  it("prefers a longer route around expensive tiles (weighted A*)", () => {
    // Row 0 is a straight 4-step route but each tile costs 10; the detour
    // through row 1 is free.
    const cost = (_c: number, r: number): number => (r === 0 ? 10 : 0);
    const path = findPath([0, 0], [4, 0], 10, open, cost);
    expect(path).not.toBeNull();
    expect(path!.slice(1, -1).every(([, r]) => r !== 0)).toBe(true);
  });

  it("does not alias tiles on grids wider than 1000 (fixed-multiplier regression)", () => {
    // With the old key(col,row) = row*1000+col, [1000,0] and [0,1] collided
    // onto one key: the goal inherited the start's gScore of 0 and could
    // never be enqueued, so this trivially-reachable path came back null.
    const path = findPath([1000, 0], [0, 1], 1500, open);
    expect(path).not.toBeNull();
    expect(path![path!.length - 1]).toEqual([0, 1]);
  });
});

describe("nextStep", () => {
  it("returns the immediate next tile toward the goal", () => {
    const step = nextStep([0, 0], [3, 0], 10, open);
    expect(step).toEqual([1, 0]);
  });

  it("returns null when already at the goal or no path exists", () => {
    expect(nextStep([2, 2], [2, 2], 10, open)).toBeNull();
    const walled = (c: number): boolean => c !== 1;
    expect(nextStep([0, 0], [3, 0], 5, walled)).toBeNull();
  });

  it("first step respects passability", () => {
    const blocked = new Set(["1,0"]);
    const passable = (c: number, r: number): boolean => !blocked.has(`${c},${r}`);
    const step = nextStep([0, 0], [3, 0], 10, passable) as GridVec;
    expect(step).not.toBeNull();
    expect(passable(step[0], step[1])).toBe(true);
  });
});
