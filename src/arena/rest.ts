import { config } from "../config";
import { child } from "../shared/logger";
import type {
  ArenaMapResponse,
  ArenaStatus,
  BotConfig,
  BotCosmeticsResponse,
  BotLiveState,
  BotStats,
  BountyResponse,
  CosmeticsCatalogResponse,
  EquipCosmeticRequest,
  GenerateKeyResponse,
  LeaderboardResponse,
  ServiceStatusRest,
  WeaponStatsResponse,
} from "../types/protocol";

const log = child("arena:rest");

interface FetchOpts {
  method?: string;
  body?: unknown;
  auth?: boolean;
  timeoutMs?: number;
}

/**
 * Thin REST client for the arena HTTP API. Used out-of-band by the Brain (to
 * read the leaderboard/bounties for strategy) and by tooling (key generation).
 * Never on the Engine hot path.
 */
export class ArenaRest {
  constructor(
    private readonly base: string = config.arena.httpBase,
    private readonly apiKey: string = config.arena.apiKey,
  ) {}

  private async request<T>(path: string, opts: FetchOpts = {}): Promise<T> {
    const url = `${this.base}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.auth && this.apiKey) headers["X-Arena-Key"] = this.apiKey;

    try {
      const res = await fetch(url, {
        method: opts.method ?? "GET",
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`${opts.method ?? "GET"} ${path} -> ${res.status} ${text.slice(0, 200)}`);
      }
      return (text ? JSON.parse(text) : {}) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  // --- public, no auth ---
  generateKey(): Promise<GenerateKeyResponse> {
    return this.request<GenerateKeyResponse>("/api/v1/keys/generate", { method: "POST", body: {} });
  }

  getStatus(): Promise<ArenaStatus> {
    return this.request<ArenaStatus>("/api/v1/arena/status");
  }

  /**
   * Live caveats (verified 2026-07-02): any `period` other than all_time
   * returns a correct `total` but an EMPTY `entries` array (server-side bug —
   * don't build features on it), and `sort=kd_ratio` silently orders like
   * kills. `sort=elo|kills|streak` and limit/offset work as expected.
   */
  getLeaderboard(params: {
    sort?: "elo" | "kills" | "streak" | "kd_ratio";
    limit?: number;
    period?: "all_time" | "30d" | "7d" | "24h" | "1h";
  } = {}): Promise<LeaderboardResponse> {
    const q = new URLSearchParams();
    if (params.sort) q.set("sort", params.sort);
    if (params.limit) q.set("limit", String(params.limit));
    if (params.period) q.set("period", params.period);
    const qs = q.toString();
    return this.request<LeaderboardResponse>(`/api/v1/leaderboard${qs ? `?${qs}` : ""}`);
  }

  getBounties(): Promise<BountyResponse> {
    return this.request<BountyResponse>("/api/v1/bounties");
  }

  getWeaponStats(): Promise<WeaponStatsResponse> {
    return this.request<WeaponStatsResponse>("/api/v1/weapon-stats");
  }

  getMap(): Promise<ArenaMapResponse> {
    return this.request<ArenaMapResponse>("/api/v1/arena/map");
  }

  /** The arena's authoritative machine-readable spec (actions, mechanics,
   * formulas, weapons, protocol) — the source docs/arena-spec.md transcribes. */
  getBotSetup(): Promise<unknown> {
    return this.request<unknown>("/api/v1/bot-setup");
  }

  /** Health check: {"status": "ok", "bots_online": N}. */
  getHealth(): Promise<{ status: string; bots_online?: number }> {
    return this.request<{ status: string; bots_online?: number }>("/api/v1/health");
  }

  /** Current operator broadcast / scheduled-maintenance status (no-store). */
  getServiceStatus(): Promise<ServiceStatusRest> {
    return this.request<ServiceStatusRest>("/api/v1/service-status");
  }

  /** Public presentation-only cosmetics catalog (no gameplay effect). */
  getCosmeticsCatalog(): Promise<CosmeticsCatalogResponse> {
    return this.request<CosmeticsCatalogResponse>("/api/v1/cosmetics/catalog");
  }

  // --- authenticated ---
  putConfig(cfg: BotConfig): Promise<unknown> {
    return this.request("/api/v1/bot/config", { method: "PUT", body: cfg, auth: true });
  }

  revokeKey(): Promise<unknown> {
    return this.request("/api/v1/keys/revoke", { method: "DELETE", auth: true });
  }

  getBotStats(): Promise<BotStats> {
    return this.request<BotStats>("/api/v1/bot/stats", { auth: true });
  }

  /** Real-time in-game state incl. the server's per-action histogram
   * (action_counts) — a self-check that intended actions actually register. */
  getBotLive(): Promise<BotLiveState> {
    return this.request<BotLiveState>("/api/v1/bot/live", { auth: true });
  }

  /** Our free + account-assigned cosmetics (owned/locked/equipped). */
  getBotCosmetics(): Promise<BotCosmeticsResponse> {
    return this.request<BotCosmeticsResponse>("/api/v1/bot/cosmetics", { auth: true });
  }

  /** Equip one owned cosmetic by slot — presentation only, never gameplay. */
  putBotCosmetics(req: EquipCosmeticRequest): Promise<unknown> {
    return this.request("/api/v1/bot/cosmetics", { method: "PUT", body: req, auth: true });
  }

  /** Best-effort: returns null on any failure so callers never crash on telemetry. */
  async tryGetLeaderboard(limit = 10): Promise<LeaderboardResponse | null> {
    try {
      return await this.getLeaderboard({ sort: "elo", limit });
    } catch (e) {
      log.debug({ err: (e as Error).message }, "leaderboard fetch failed");
      return null;
    }
  }

  async tryGetBounties(): Promise<BountyResponse | null> {
    try {
      return await this.getBounties();
    } catch (e) {
      log.debug({ err: (e as Error).message }, "bounty fetch failed");
      return null;
    }
  }

  async tryGetWeaponStats(): Promise<WeaponStatsResponse | null> {
    try {
      return await this.getWeaponStats();
    } catch (e) {
      log.debug({ err: (e as Error).message }, "weapon stats fetch failed");
      return null;
    }
  }

  async tryGetBotStats(): Promise<BotStats | null> {
    try {
      return await this.getBotStats();
    } catch (e) {
      log.debug({ err: (e as Error).message }, "bot stats fetch failed");
      return null;
    }
  }

  async tryGetArenaStatus(): Promise<ArenaStatus | null> {
    try {
      return await this.getStatus();
    } catch (e) {
      log.debug({ err: (e as Error).message }, "arena status fetch failed");
      return null;
    }
  }
}

export const arenaRest = new ArenaRest();
