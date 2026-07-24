/**
 * One test per rung of the controller's priority cascade (see the class doc in
 * src/engine/controller.ts) — each scenario is engineered so the rung under
 * test is the one that claims the tick.
 */
import { describe, expect, it } from "vitest";
import { Controller } from "../src/engine/controller";
import { DEFAULT_POLICY } from "../src/types/internal";
import type { NearbyEntity } from "../src/types/protocol";
import { enemy, freshGameState, pickup, self, tickFrom } from "./helpers";

function controller(): Controller {
  const ctl = new Controller();
  ctl.onRoundStart();
  return ctl;
}

describe("priority 1 — can't act", () => {
  it("dead -> idle", () => {
    const gs = freshGameState();
    gs.applyTick(tickFrom(self({ is_alive: false, hp: 0 }), [enemy()]));
    expect(controller().decide(gs).action).toBe("idle");
  });

  it("respawning -> idle", () => {
    const gs = freshGameState();
    gs.applyTick(tickFrom(self(), [enemy()]));
    gs.isRespawning = true;
    expect(controller().decide(gs).action).toBe("idle");
  });

  it("stunned -> idle", () => {
    const gs = freshGameState();
    gs.applyTick(tickFrom(self({ stun_ticks: 3 }), [enemy()]));
    expect(controller().decide(gs).action).toBe("idle");
  });
});

describe("priority 2 — survive the environment", () => {
  it("outside the zone with no threats -> threat-field step toward the zone", () => {
    const gs = freshGameState();
    gs.applyTick(tickFrom(self({ in_safe_zone: false, position: [90, 90], zone_center: [50, 50] })));
    const a = controller().decide(gs);
    expect(a.action).toBe("move");
    if (a.action === "move") {
      // Zone centre is up-left of us — the step must not increase either axis.
      expect(a.direction[0]).toBeLessThanOrEqual(0);
      expect(a.direction[1]).toBeLessThanOrEqual(0);
    }
  });
});

describe("priority 3 — emergency dodge", () => {
  it("charged shot lined up + dodge ready -> dodge", () => {
    const gs = freshGameState();
    gs.applyTick(
      tickFrom(self({ dodge_cooldown: 0, weapon_ready: false }), [
        enemy({ weapon: "bow", position: [54, 50], attack_range: 7, charged_shot_ready: true }),
      ]),
    );
    expect(controller().decide(gs).action).toBe("dodge");
  });

  it("dodge outranks the zone-return move when both apply", () => {
    const gs = freshGameState();
    gs.applyTick(
      tickFrom(
        self({ in_safe_zone: false, position: [90, 50], zone_center: [50, 50], dodge_cooldown: 0, weapon_ready: false }),
        [enemy({ weapon: "bow", position: [92, 50], attack_range: 7, charged_shot_ready: true })],
      ),
    );
    expect(controller().decide(gs).action).toBe("dodge");
  });
});

describe("priority 4 — retreat & heal", () => {
  it("low HP with a chaser -> survival action, never a trade", () => {
    const gs = freshGameState();
    gs.applyTick(tickFrom(self({ hp: 16, max_hp: 160 }), [enemy({ position: [52, 50] })]));
    const a = controller().decide(gs);
    expect(["move", "move_to", "place_mine", "dodge"]).toContain(a.action);
    expect(a.action).not.toBe("attack");
  });
});

describe("priority 5 — mine the retreat path", () => {
  it("single adjacent chaser (necessarily behind the flight direction) -> place_mine", () => {
    const gs = freshGameState();
    gs.applyTick(tickFrom(self({ hp: 10, max_hp: 160 }), [enemy({ bot_id: "chaser", position: [51, 50] })]));
    expect(controller().decide(gs).action).toBe("place_mine");
  });

  it("an enemy ahead of the retreat direction is not mined", () => {
    const gs = freshGameState();
    gs.applyTick(
      tickFrom(self({ hp: 10, max_hp: 160 }), [
        enemy({ bot_id: "dominant", position: [56, 50], attack_range: 6, threat_score: 200 }),
        enemy({ bot_id: "westfoe", position: [47, 50], attack_range: 1, threat_score: 1 }),
      ]),
    );
    expect(controller().decide(gs).action).toBe("move");
  });
});

describe("priority 6 — gravity well on clusters", () => {
  it("staff + collected charge + clustered enemies -> use_gravity_well", () => {
    const ctl = controller();
    ctl.setPolicy({ ...DEFAULT_POLICY });
    const gs = freshGameState();
    gs.setConfirmedAttackRange(5);
    const entities: NearbyEntity[] = [
      enemy({ bot_id: "e1", position: [54, 50] }),
      enemy({ bot_id: "e2", position: [54, 52] }),
      pickup({ pickup_id: "gw1", pickup_type: "gravity_well", position: [52, 50] }),
    ];
    // Uncollected ground pickup must NOT cast; after collecting it, it must.
    gs.applyTick(tickFrom(self({ weapon: "staff" }), entities, 400));
    expect(ctl.decide(gs).action).not.toBe("use_gravity_well");
    gs.noteIssuedAction({ type: "action", tick: 401, action: "use_item", item_id: "gw1" });
    gs.applyTick(tickFrom(self({ weapon: "staff" }), entities, 402));
    expect(ctl.decide(gs).action).toBe("use_gravity_well");
  });
});

describe("priority 7 — engage the chosen target", () => {
  it("adjacent enemy + weapon ready -> attack it", () => {
    const gs = freshGameState();
    gs.applyTick(tickFrom(self(), [enemy({ position: [51, 50] })]));
    const a = controller().decide(gs);
    expect(a.action).toBe("attack");
    if (a.action === "attack") expect(a.target).toBe("enemy1");
  });

  it("enemy out of reach -> positions for combat instead", () => {
    const gs = freshGameState();
    gs.applyTick(tickFrom(self({ grapple_charges: 0 }), [enemy({ position: [55, 50] })]));
    expect(controller().decide(gs).action).toBe("move_to");
  });
});

describe("priority 8 — grab pickups", () => {
  it("hurt + quiet arena -> follows a health-pack hint over a bot hint", () => {
    const gs = freshGameState();
    gs.applyTick(tickFrom(self({ hp: 80, max_hp: 160 }), []));
    gs.hints = [
      { hint_type: "bot", direction: [1, 0], distance: 200 },
      { hint_type: "pickup", pickup_type: "health_pack", direction: [-1, 0], distance: 300 },
    ];
    const a = controller().decide(gs);
    expect(a.action).toBe("move_to");
    if (a.action === "move_to") expect(a.target_position[0]).toBeLessThan(50);
  });
});

describe("priority 9 — hold ground / default reposition", () => {
  it("empty fog, no hints -> still emits a deliberate action (never throws, never idles forever)", () => {
    const gs = freshGameState();
    gs.applyTick(tickFrom(self(), []));
    const a = controller().decide(gs);
    expect(["move", "move_to", "idle"]).toContain(a.action);
  });

  it("nav hint toward a distant bot -> hunts in that direction", () => {
    const gs = freshGameState();
    gs.applyTick(tickFrom(self({ position: [50, 50] }), []));
    gs.hints = [{ hint_type: "bot", direction: [1, 0], distance: 200 }];
    const a = controller().decide(gs);
    expect(a.action).toBe("move_to");
    if (a.action === "move_to") expect(a.target_position[0]).toBeGreaterThan(50);
  });
});
