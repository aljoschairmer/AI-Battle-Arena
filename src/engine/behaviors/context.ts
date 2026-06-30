import type { GameState } from "../gameState";
import type { Directive } from "../../types/internal";
import type {
  ClientAction,
  GridVec,
} from "../../types/protocol";

/** Everything a behaviour needs to make a decision for the current tick. */
export interface DecisionContext {
  gs: GameState;
  directive: Directive;
  tick: number;
}

/** A behaviour returns an action, or null to defer to the next behaviour. */
export type Behavior = (ctx: DecisionContext) => ClientAction | null;

// --- action constructors (keep the `tick` plumbing in one place) ------------

export function move(tick: number, direction: GridVec): ClientAction {
  return { type: "action", tick, action: "move", direction };
}

export function sprint(tick: number, direction: GridVec): ClientAction {
  return { type: "action", tick, action: "move", direction };
}

export function moveTo(tick: number, target_position: GridVec): ClientAction {
  return { type: "action", tick, action: "move_to", target_position };
}
export function sprintTo(tick: number, target_position: GridVec): ClientAction {
  return { type: "action", tick, action: "move_to", target_position };
}
export function attack(tick: number, target: string, charged = false): ClientAction {
  return charged
    ? { type: "action", tick, action: "attack", target, charged: true }
    : { type: "action", tick, action: "attack", target };
}

/** Staff AoE: place the delayed burn field at a grid tile (still references a target). */
export function attackAt(tick: number, target: string, target_position: GridVec): ClientAction {
  return { type: "action", tick, action: "attack", target, target_position };
}

export function dodge(tick: number, direction: GridVec): ClientAction {
  return { type: "action", tick, action: "dodge", direction };
}

export function shove(tick: number, target: string): ClientAction {
  return { type: "action", tick, action: "shove", target };
}

export function placeMine(tick: number): ClientAction {
  return { type: "action", tick, action: "place_mine" };
}

export function grappleTarget(tick: number, target: string): ClientAction {
  return { type: "action", tick, action: "grapple", target };
}

export function grappleTo(tick: number, target_position: GridVec): ClientAction {
  return { type: "action", tick, action: "grapple", target_position };
}

export function gravityWell(tick: number, target_position: GridVec): ClientAction {
  return { type: "action", tick, action: "use_gravity_well", target_position };
}

export function useItem(tick: number, item_id: string): ClientAction {
  return { type: "action", tick, action: "use_item", item_id };
}

export function idle(tick: number): ClientAction {
  return { type: "action", tick, action: "idle" };
}
