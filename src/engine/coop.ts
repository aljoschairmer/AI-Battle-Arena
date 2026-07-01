import { type Bus, Channels } from "../bus";
import { child } from "../shared/logger";
import type { CoopMessage } from "../types/internal";

const log = child("coop");

const MEMBER_TTL_MS = 8000; // drop an ally we haven't heard from in this long
const ENEMY_TTL_MS = 4000; // forget an ally-reported enemy after this long

/**
 * Bot-to-bot coalition (BOT_COOP). Runs on the GLOBAL bus so every one of our
 * parallel bots hears every other. It gives allies three things:
 *  - non-aggression: allies learn each other's arena bot_ids (friendlyIds) so
 *    they never target one another,
 *  - focus fire: allies converge on the lowest-HP enemy anyone can see (focus),
 *  - shared intel: enemy sightings are pooled across the coalition.
 *
 * Purely additive and best-effort — if it's disabled or a peer is silent, each
 * bot just fights on its own.
 */
export class Coalition {
  private readonly members = new Map<string, number>(); // botId -> lastSeen ms
  private readonly enemies = new Map<string, { hp: number; ts: number }>(); // enemyId -> latest
  private unsub: (() => void) | null = null;

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
    log.info("coalition online");
  }

  /** Broadcast our view; also fold our own sightings into the shared pool. */
  report(msg: CoopMessage): void {
    const now = Date.now();
    for (const e of msg.enemies) this.enemies.set(e.id, { hp: e.hp, ts: now });
    void this.bus.publish(Channels.coop, msg);
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

  /** Coalition focus = lowest-HP enemy any ally recently reported (never an ally). */
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
    return best;
  }

  stop(): void {
    this.unsub?.();
    this.unsub = null;
  }
}
