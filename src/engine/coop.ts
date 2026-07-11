import { type Bus, Channels } from "../bus";
import { child } from "../shared/logger";
import type { CoopDirective, CoopMessage, CoopRole } from "../types/internal";
import { DEFAULT_COOP_DIRECTIVE, isFresher } from "../types/internal";

const log = child("coop");

/**
 * LAST FLEET STANDING: true when the fog-free spectator frame shows that
 * every living bot besides ourselves is one of OUR coalition members. Only
 * one bot can win a round, so from that moment the truce is pointless — the
 * engine clears its friendly set and the fleet fights it out instead of
 * idling next to each other until the zone decides. Deliberately
 * conservative: no frame (feed down/stale), an empty alive list, or an empty
 * friendly set all mean "keep the truce".
 */
export function onlyFleetRemains(
  aliveOthers: { id: string }[] | null | undefined,
  friendly: Set<string>,
): boolean {
  if (!aliveOthers || aliveOthers.length === 0) return false;
  if (friendly.size === 0) return false;
  return aliveOthers.every((b) => friendly.has(b.id));
}

/**
 * Count-based truce-break fallback for when the spectator feed is disabled
 * or stale (ARENA_SPECTATOR=false ran a whole A/B arm with the truce
 * permanently stuck on): the arena's REST status reports the GLOBAL alive
 * count, coop reports give OUR alive count — when they match, everyone still
 * standing is ours. Strict equality on purpose: a global count LOWER than
 * our believed count means one of our alive-beliefs is stale (a survivor
 * could be an enemy), so no break. Needs 2+ of us (a duel takes two) and a
 * known count; both missing/ambiguous cases keep the truce.
 */
export function onlyFleetRemainsByCount(globalAlive: number | null, ourAlive: number): boolean {
  if (globalAlive === null || globalAlive <= 0) return false;
  if (ourAlive < 2) return false;
  return globalAlive === ourAlive;
}

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
  /**
   * Every botId EVER seen as a coalition member this process lifetime.
   * Non-aggression must not expire: reports are tick-driven, and ticks stop
   * between rounds and across reconnects, so a TTL'd friendly set goes empty
   * while the teammates are still ours — observed live (pass-3 prod run) as a
   * bot killing its own coalition partner at endgame. Liveness-sensitive data
   * (focus picks, roles) keeps its TTLs; friendship does not.
   */
  private readonly everMembers = new Set<string>();
  private readonly enemies = new Map<string, { hp: number; ts: number }>(); // enemyId -> latest
  /** Latest reported HP per ally — liveness data, TTL'd unlike membership. */
  private readonly memberHp = new Map<string, { hp: number; maxHp?: number; ts: number }>();
  /** Latest broadcast mine tiles per ally (mines are invisible to non-owners). */
  private readonly memberMines = new Map<string, { tiles: [number, number][]; ts: number }>();
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
      this.everMembers.add(m.botId);
      // Live HP per ally (reports flow even while dead, hp 0) — feeds the
      // count-based truce-break fallback (aliveAllies) and the low-HP peel set.
      this.memberHp.set(m.botId, {
        hp: typeof m.hp === "number" ? m.hp : 0,
        maxHp: typeof m.maxHp === "number" && m.maxHp > 0 ? m.maxHp : undefined,
        ts: now,
      });
      // Latest report wins wholesale: an ally with no live mines broadcasts
      // an empty list, clearing its previous tiles.
      this.memberMines.set(m.botId, { tiles: Array.isArray(m.mines) ? m.mines : [], ts: now });
      // A member is never an enemy: purge it from the shared pool (it may have
      // been inserted by an ally whose own friendly set was momentarily stale)
      // and never let a report re-insert any known member.
      this.enemies.delete(m.botId);
      for (const e of m.enemies) {
        // Never pool ourselves or any known member as an enemy, whatever a
        // (possibly momentarily confused) ally reports.
        if (e.id === this.selfId() || this.everMembers.has(e.id)) continue;
        this.enemies.set(e.id, { hp: e.hp, ts: now });
      }
    });
    this.unsubDirective = await this.bus.subscribe<CoopDirective>(Channels.coopDirective, (d) => {
      if (!d || typeof d.version !== "number" || typeof d.ts !== "number") return;
      // Newest wins; a restarted Coordinator (version counter reset) is still
      // accepted via the newer-ts path instead of being ignored forever.
      if (!isFresher(this.coopDirective, d)) return;
      this.coopDirective = d;
    });
    log.info("coalition online");
  }

  /** Broadcast our view; also fold our own sightings into the shared pool. */
  report(msg: CoopMessage): void {
    const now = Date.now();
    for (const e of msg.enemies) {
      if (e.id === this.selfId() || this.everMembers.has(e.id)) continue; // never pool self/teammates
      this.enemies.set(e.id, { hp: e.hp, ts: now });
    }
    this.bus.publish(Channels.coop, msg).catch((e) => log.warn({ err: (e as Error).message }, "coop report publish failed"));
  }

  /**
   * Arena bot_ids of allies — permanent for the process lifetime (see
   * everMembers). The recency map is still maintained (MEMBER_TTL_MS) for
   * anything that needs liveness, but non-aggression never expires.
   */
  friendlyIds(): Set<string> {
    const now = Date.now();
    for (const [id, ts] of this.members) {
      if (now - ts >= MEMBER_TTL_MS) this.members.delete(id);
    }
    return new Set(this.everMembers);
  }

  /**
   * How many allies (NOT counting ourselves) are alive right now, judged by
   * fresh coop reports with hp > 0. Reports keep flowing while an ally is
   * dead/respawning (hp 0), so this is accurate within a report interval;
   * an ally whose reports stopped entirely (crash, eliminated) ages out via
   * the TTL and stops counting. Powers the truce-break fallback when the
   * spectator feed is unavailable.
   */
  aliveAllies(maxAgeMs = 4000): number {
    const now = Date.now();
    let n = 0;
    for (const [, s] of this.memberHp) {
      if (now - s.ts <= maxAgeMs && s.hp > 0) n++;
    }
    return n;
  }

  /**
   * Allies currently ALIVE but LOW on HP (< 40% of their reported max, or
   * < 55 absolute when an older peer doesn't send maxHp). These are assassin
   * bait — the arena's assassin-strategy demo bots always hunt the weakest
   * visible bot — so targeting pays a peel bonus for enemies locked onto
   * them. Fresh reports only: a silent ally ages out with the TTL.
   */
  lowHpAllies(maxAgeMs = 4000): Set<string> {
    const now = Date.now();
    const out = new Set<string>();
    for (const [id, s] of this.memberHp) {
      if (now - s.ts > maxAgeMs || s.hp <= 0) continue;
      const low = s.maxHp ? s.hp / s.maxHp < 0.4 : s.hp < 55;
      if (low) out.add(id);
    }
    return out;
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

  /**
   * All coalition allies' broadcast mine tiles (deduped). TTL'd on the
   * MEMBER_TTL_MS recency window: a silent ally's mines eventually expire with
   * the round anyway, and stale tiles would phantom-block ground forever.
   */
  friendlyMines(): [number, number][] {
    const now = Date.now();
    const out: [number, number][] = [];
    const seen = new Set<string>();
    for (const [id, m] of this.memberMines) {
      if (now - m.ts >= MEMBER_TTL_MS) {
        this.memberMines.delete(id);
        continue;
      }
      for (const t of m.tiles) {
        const key = `${t[0]},${t[1]}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push(t);
        }
      }
    }
    return out;
  }

  /** Our assigned squad role (hold/flank/support), or null with no fresh call. */
  role(): CoopRole | null {
    const d = this.coopDirective;
    if (Date.now() - d.ts > DIRECTIVE_STALE_MS) return null;
    return d.roles[this.selfId()] ?? null;
  }

  // (shouldRegroup() was removed as dead code — no behavior ever consumed the
  // Coordinator's regroup call. CoopDirective.regroup stays on the wire; wire
  // a consumer before resurrecting the accessor.)

  stop(): void {
    this.unsub?.();
    this.unsub = null;
    this.unsubDirective?.();
    this.unsubDirective = null;
  }
}
