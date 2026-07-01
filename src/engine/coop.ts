import { type Bus, Channels } from "../bus";
import { child } from "../shared/logger";
import type { CoopDirective, CoopMessage, CoopRole } from "../types/internal";
import { DEFAULT_COOP_DIRECTIVE } from "../types/internal";

const log = child("coop");

const MEMBER_TTL_MS = 8000; // drop an ally we haven't heard from in this long
const ENEMY_TTL_MS = 4000; // forget an ally-reported enemy after this long
const DIRECTIVE_STALE_MS = 12000; // ignore a Coordinator directive this old

/**
 * Bot-to-bot coalition (BOT_COOP). Runs on the GLOBAL bus so every one of our
 * parallel bots hears every other. It gives allies four things:
 *  - non-aggression: allies learn each other's arena bot_ids (friendlyIds) so
 *    they never target one another,
 *  - focus fire: allies converge on a shared target — the Coordinator brain's
 *    call when it's running and fresh, else the local lowest-HP heuristic,
 *  - shared intel: enemy sightings are pooled across the coalition,
 *  - squad roles: hold/flank/support, when the Coordinator has assigned one.
 *
 * Purely additive and best-effort — if it's disabled or a peer is silent, each
 * bot just fights on its own.
 */
export class Coalition {
  private readonly members = new Map<string, number>(); // botId -> lastSeen ms
  private readonly enemies = new Map<string, { hp: number; ts: number }>(); // enemyId -> latest
  private coopDirective: CoopDirective = { ...DEFAULT_COOP_DIRECTIVE };
  private unsub: (() => void) | null = null;
  private unsubDirective: (() => void) | null = null;

  constructor(
    private readonly bus: Bus,
    private readonly selfId: () => string,
  ) {}

  async start(): Promise<void> {
    this.unsub = await this.bus.subscribe<CoopMessage>(Channels.coop, (m) => {
      if (!m || !m.botId || m.botId === this.selfId()) return; // ignore our own echo
      const now = Date.now();
      this.members.set(m.botId, now);
      for (const e of m.enemies) this.enemies.set(e.id, { hp: e.hp, ts: now });
    });
    this.unsubDirective = await this.bus.subscribe<CoopDirective>(Channels.coopDirective, (d) => {
      if (!d || d.version <= this.coopDirective.version) return; // newest wins
      this.coopDirective = d;
    });
    log.info("coalition online");
  }

  /** Broadcast our view; also fold our own sightings into the shared pool. */
  report(msg: CoopMessage): void {
    const now = Date.now();
    for (const e of msg.enemies) this.enemies.set(e.id, { hp: e.hp, ts: now });
    this.bus.publish(Channels.coop, msg).catch((e) => log.warn({ err: (e as Error).message }, "coop report publish failed"));
  }

  /** Arena bot_ids of allies we've heard from recently. */
  friendlyIds(): Set<string> {
    const now = Date.now();
    const s = new Set<string>();
    for (const [id, ts] of this.members) {
      if (now - ts < MEMBER_TTL_MS) s.add(id);
      else this.members.delete(id);
    }
    return s;
  }

  /**
   * Coalition focus target: the Coordinator brain's concentrated-fire call
   * when it's running and its pick is still a live-tracked, non-friendly
   * enemy; otherwise falls back to the local lowest-HP heuristic so the squad
   * still focus-fires even with no LLM coordinator (or a stale/quiet one).
   */
  focus(): string | null {
    const now = Date.now();
    const friends = this.friendlyIds();

    let best: string | null = null;
    let bestHp = Infinity;
    for (const [id, e] of this.enemies) {
      if (now - e.ts > ENEMY_TTL_MS) {
        this.enemies.delete(id);
        continue;
      }
      if (friends.has(id)) continue;
      if (e.hp < bestHp) {
        bestHp = e.hp;
        best = id;
      }
    }

    const d = this.coopDirective;
    const directiveFresh = now - d.ts <= DIRECTIVE_STALE_MS;
    if (
      directiveFresh &&
      d.focusTargetId &&
      !friends.has(d.focusTargetId) &&
      this.enemies.has(d.focusTargetId)
    ) {
      return d.focusTargetId;
    }
    return best;
  }

  /** Our assigned squad role (hold/flank/support), or null with no fresh call. */
  role(): CoopRole | null {
    const d = this.coopDirective;
    if (Date.now() - d.ts > DIRECTIVE_STALE_MS) return null;
    return d.roles[this.selfId()] ?? null;
  }

  /** True when the Coordinator has called a squad-wide regroup/fallback. */
  shouldRegroup(): boolean {
    const d = this.coopDirective;
    return Date.now() - d.ts <= DIRECTIVE_STALE_MS && d.regroup;
  }

  stop(): void {
    this.unsub?.();
    this.unsub = null;
    this.unsubDirective?.();
    this.unsubDirective = null;
  }
}
