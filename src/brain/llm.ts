/**
 * src/brain/llm.ts
 *
 * Multi-provider LLM router with a fallback chain. Motivation (measured
 * live): the single-provider setup died for an entire afternoon when the
 * free OpenRouter route ran out of upstream balance — every agent call
 * failed while two perfectly good direct providers (Google AI Studio's free
 * tier, DashScope's near-free qwen-flash) sat unused. Routing direct also
 * skips OpenRouter's markup and extra network hop.
 *
 * All three providers speak the OpenAI chat-completions dialect, so one
 * generic client (see openrouter.ts) serves them all — each with its OWN
 * circuit breaker. chat() walks the configured chain (LLM_PROVIDERS,
 * default google,qwen,openrouter; keyless entries are skipped at build
 * time): an open circuit fails instantly and the next provider takes the
 * call, so a dead provider costs microseconds, not a dead brain.
 *
 * Model mapping: Google and Qwen run ONE model each (GOOGLE_MODEL /
 * QWEN_MODEL — flash-class by default, right for our latency budget);
 * OpenRouter keeps its per-agent slugs (OPENROUTER_MODEL_*), passed through
 * by the caller.
 */

import { config } from "../config";
import { child } from "../shared/logger";
import { OpenRouter } from "./openrouter";

const log = child("llm");

export interface AgentChatRequest {
  /** Per-agent OpenRouter slug — used only when the openrouter link serves the call. */
  openrouterModel: string;
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
}

interface ChainLink {
  name: string;
  client: OpenRouter;
  /** Fixed model for this provider; null = use the request's OpenRouter slug. */
  model: string | null;
}

export function buildChain(): ChainLink[] {
  const links: ChainLink[] = [];
  for (const p of config.llm.providerOrder) {
    if (p === "google" && config.google.apiKey) {
      links.push({
        name: "google",
        client: new OpenRouter(config.google.apiKey, config.google.base, undefined, "google", "/models"),
        model: config.google.model,
      });
    } else if (p === "qwen" && config.qwen.apiKey) {
      links.push({
        name: "qwen",
        client: new OpenRouter(config.qwen.apiKey, config.qwen.base, undefined, "qwen", "/models"),
        model: config.qwen.model,
      });
    } else if (p === "openrouter" && config.openrouter.apiKey) {
      links.push({
        name: "openrouter",
        client: new OpenRouter(),
        model: null,
      });
    }
  }
  return links;
}

export class LlmRouter {
  constructor(private readonly chain: ChainLink[] = buildChain()) {}

  get enabled(): boolean {
    return this.chain.length > 0;
  }

  providerNames(): string[] {
    return this.chain.map((l) => l.name);
  }

  /**
   * Try each provider in order; the first success wins. Open circuits throw
   * instantly (no network), so a known-dead provider adds ~no latency. Only
   * the LAST error propagates — intermediate failures log at debug.
   */
  async chat(req: AgentChatRequest): Promise<string> {
    let lastErr: unknown;
    for (const link of this.chain) {
      try {
        return await link.client.chat({
          model: link.model ?? req.openrouterModel,
          system: req.system,
          user: req.user,
          temperature: req.temperature,
          maxTokens: req.maxTokens,
          json: req.json,
        });
      } catch (e) {
        lastErr = e;
        log.debug({ provider: link.name, err: (e as Error).message.slice(0, 120) }, "provider failed — trying next in chain");
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("no LLM provider configured");
  }

  /** Probe every configured provider; ok when at least one answers. */
  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    if (!this.enabled) return { ok: false, detail: "no LLM provider has an API key configured" };
    const results = await Promise.all(
      this.chain.map(async (l) => ({ name: l.name, ...(await l.client.healthCheck()) })),
    );
    const up = results.filter((r) => r.ok).map((r) => r.name);
    const down = results.filter((r) => !r.ok).map((r) => `${r.name} (${r.detail.slice(0, 80)})`);
    return {
      ok: up.length > 0,
      detail: `up: ${up.join(",") || "none"}${down.length ? ` | down: ${down.join("; ")}` : ""}`,
    };
  }
}

/** Process-wide router — all agents share it (and its per-provider breakers). */
export const llm = new LlmRouter();
