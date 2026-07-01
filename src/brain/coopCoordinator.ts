import { config } from "../config";
import { type Bus, Channels, Keys } from "../bus";
import { child } from "../shared/logger";
import type { CoopDirective, CoopMessage, CoopRole } from "../types/internal";
import { DEFAULT_COOP_DIRECTIVE } from "../types/internal";
import { CoordinatorAgent } from "./agents/coordinator";
import type { CoordinatorOutput } from "./agents/schemas";

const log = child("brain:coop");

const MEMBER_TTL_MS = 8000; // matches engine/coop.ts Coalition
const ENEMY_TTL_MS = 4000;

/**
 * Squad-wide counterpart to the per-bot Orchestrator: ONE Coordinator brain
 * per coalition (not one per bot — a fireteam has one commander, not one per
 * rifle). Listens to the same GLOBAL coop channel every engine already
 * publishes to, pools squad + enemy intel, and periodically asks the
 * CoordinatorAgent for military-tactics guidance (focus-fire target + hold/
 * flank/support roles + regroup calls), publishing the result back on the
 * GLOBAL bus for every engine's Coalition to read.
 *
 * Purely additive: if this never runs (BOT_COOP off, or only one bot), every
 * engine just keeps using its own local lowest-HP focus-fire heuristic.
 */
export class CoopCoordinator {
  private readonly agent = new CoordinatorAgent();
  private readonly members = new Map<string, CoopMessage>();
  private readonly enemies = new Map<string, { hp: number; position: [number, number]; ts: number }>();
  private directive: CoopDirective = { ...DEFAULT_COOP_DIRECTIVE };
  private version = 0;
  private timer: NodeJS.Timeout | null = null;
  private unsub: (() => void) | null = null;
  private busy = false;

  constructor(private readonly bus: Bus) {}

  async start(): Promise<void> {
    const seeded = await this.bus.getKV<CoopDirective>(Keys.currentCoopDirective);
    if (seeded) {
      this.version = seeded.version;
      this.directive = seeded;
    }

    this.unsub = await this.bus.subscribe<CoopMessage>(Channels.coop, (m) => {
      if (!m || !m.botId) return;
      this.members.set(m.botId, m);
      for (const e of m.enemies) this.enemies.set(e.id, { hp: e.hp, position: e.pos, ts: Date.now() });
    });

    this.timer = setInterval(() => void this.tick(), Math.max(1000, config.coop.coordinatorIntervalMs));
    log.info("coordinator online (squad-wide military tactics)");
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsub?.();
    this.unsub = null;
    log.info("coordinator stopped");
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    const now = Date.now();
    for (const [id, m] of this.members) if (now - m.ts > MEMBER_TTL_MS) this.members.delete(id);
    for (const [id, e] of this.enemies) if (now - e.ts > ENEMY_TTL_MS) this.enemies.delete(id);

    // Need an actual squad (2+ allies reporting in) and at least one tracked
    // enemy — otherwise there's nothing to coordinate.
    if (this.members.size < 2 || this.enemies.size === 0) return;

    this.busy = true;
    try {
      const out = await this.agent.run({
        members: [...this.members.values()].map((m) => ({
          botId: m.botId,
          name: m.name,
          weapon: m.weapon,
          hp: m.hp,
          position: m.pos,
        })),
        enemies: [...this.enemies.entries()].map(([id, e]) => ({ id, hp: e.hp, position: e.position })),
        currentFocusTargetId: this.directive.focusTargetId,
      });
      if (out) this.publish(out);
    } finally {
      this.busy = false;
    }
  }

  private publish(out: CoordinatorOutput): void {
    const memberIds = new Set(this.members.keys());
    const roles: Record<string, CoopRole> = {};
    for (const [id, role] of Object.entries(out.roles)) {
      if (memberIds.has(id)) roles[id] = role;
    }

    const next: CoopDirective = {
      version: ++this.version,
      ts: Date.now(),
      focusTargetId: out.focusTargetId && this.enemies.has(out.focusTargetId) ? out.focusTargetId : null,
      roles,
      regroup: out.regroup,
      reasoning: out.reasoning,
      source: "coordinator",
    };
    this.directive = next;
    this.bus
      .publish(Channels.coopDirective, next)
      .catch((e) => log.warn({ err: (e as Error).message }, "coop directive publish failed"));
    this.bus
      .setKV(Keys.currentCoopDirective, next)
      .catch((e) => log.warn({ err: (e as Error).message }, "coop directive KV mirror failed"));
    log.info(
      { v: next.version, focus: next.focusTargetId, roles: next.roles, regroup: next.regroup },
      "coop directive published",
    );
  }
}
