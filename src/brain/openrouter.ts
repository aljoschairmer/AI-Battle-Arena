import { config } from "../config";
import { child } from "../shared/logger";

const log = child("openrouter");

export interface ChatRequest {
  model: string;
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** Ask the provider to emit a single JSON object. */
  json?: boolean;
}

interface ChatCompletion {
  choices?: { message?: { content?: string } }[];
  error?: { message?: string };
}

/**
 * Minimal OpenRouter chat client built on fetch — no SDK needed. Adds the
 * attribution headers OpenRouter recommends, a hard timeout (so a hung LLM can
 * never stall the strategy loop), one retry on transient failures, and a
 * process-wide CIRCUIT BREAKER.
 *
 * The breaker exists because of a measured live incident: the free-tier
 * provider went down (402 upstream balance) and six agents kept hammering it
 * every 2.5-3s — ~1950 failed calls in one afternoon, which tripped
 * OpenRouter's own "too many failed attempts, wait 30s" lockout (429) and
 * kept the account locked in a spiral. Worse, every failure logged only a
 * per-call WARN, so the outage was invisible unless you grepped for it.
 * After BREAK_AFTER consecutive failures the circuit OPENS for COOLDOWN_MS:
 * calls fail instantly without touching the API (the deterministic fallback
 * plays on, exactly as designed) and ONE loud ERROR marks the outage. After
 * the cooldown the next call probes; success closes the circuit, failure
 * re-opens it (one ERROR per cooldown period, not thousands of WARNs).
 */
export class OpenRouter {
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;

  constructor(
    private readonly apiKey = config.openrouter.apiKey,
    private readonly base = config.openrouter.base,
    private readonly breaker: { after: number; cooldownMs: number } = { after: 8, cooldownMs: 90_000 },
  ) {}

  get enabled(): boolean {
    return this.apiKey.length > 0;
  }

  /**
   * Boot-time check: GET /api/v1/key (auth-gated — 401 on a bad/missing key).
   * Confirms BOTH the key is valid AND the network path (incl. any corporate
   * proxy / Zscaler) actually reaches openrouter.ai — so a silent "no LLM calls"
   * surfaces as a concrete error at startup instead of a mystery.
   */
  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    if (!this.enabled) return { ok: false, detail: "OPENROUTER_API_KEY is empty" };
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(`${this.base}/key`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: controller.signal,
      });
      const text = await res.text();
      if (res.status === 401 || res.status === 403) {
        return { ok: false, detail: `invalid OPENROUTER_API_KEY (HTTP ${res.status})` };
      }
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status}: ${text.slice(0, 160)}` };
      let usage: unknown;
      try {
        usage = (JSON.parse(text) as { data?: { usage?: unknown } }).data?.usage;
      } catch {
        /* body is optional */
      }
      return { ok: true, detail: `key valid, reachable (usage=${String(usage ?? "?")})` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    } finally {
      clearTimeout(t);
    }
  }

  async chat(req: ChatRequest): Promise<string> {
    const now = Date.now();
    if (now < this.circuitOpenUntil) {
      throw new Error(
        `LLM circuit open — cooling down ${Math.ceil((this.circuitOpenUntil - now) / 1000)}s after repeated provider failures`,
      );
    }
    const timeout = req.timeoutMs ?? config.openrouter.timeoutMs;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const out = await this.once(req, timeout);
        if (this.consecutiveFailures >= this.breaker.after) {
          log.info("LLM circuit CLOSED — provider recovered");
        }
        this.consecutiveFailures = 0;
        return out;
      } catch (e) {
        lastErr = e;
        const msg = (e as Error).message;
        // Don't retry client errors (bad request / auth) — only transient ones.
        if (/\b(400|401|403)\b/.test(msg)) break;
        log.debug({ attempt, err: msg }, "chat attempt failed, retrying");
        await sleep(250 * (attempt + 1));
      }
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.breaker.after) {
      this.circuitOpenUntil = Date.now() + this.breaker.cooldownMs;
      // ERROR on purpose (the only one this client emits): a dead LLM layer
      // must be impossible to miss in the logs, unlike per-call WARNs.
      log.error(
        {
          consecutiveFailures: this.consecutiveFailures,
          cooldownS: Math.round(this.breaker.cooldownMs / 1000),
          lastErr: lastErr instanceof Error ? lastErr.message.slice(0, 160) : String(lastErr),
        },
        "LLM circuit OPEN — provider failing repeatedly, pausing all LLM calls (deterministic fallback active)",
      );
    }
    throw lastErr instanceof Error ? lastErr : new Error("OpenRouter chat failed");
  }

  private async once(req: ChatRequest, timeoutMs: number): Promise<string> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.base}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": config.openrouter.siteUrl,
          "X-Title": config.openrouter.appName,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: req.model,
          temperature: req.temperature ?? 0.4,
          max_tokens: req.maxTokens ?? 400,
          ...(req.json ? { response_format: { type: "json_object" } } : {}),
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.user },
          ],
        }),
      });

      const text = await res.text();
      if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 200)}`);

      const data = JSON.parse(text) as ChatCompletion;
      if (data.error?.message) throw new Error(`OpenRouter error: ${data.error.message}`);
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error("OpenRouter returned no content");
      return content;
    } finally {
      clearTimeout(t);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const openrouter = new OpenRouter();
