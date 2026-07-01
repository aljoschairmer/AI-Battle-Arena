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
 * never stall the strategy loop), and one retry on transient failures.
 */
export class OpenRouter {
  constructor(
    private readonly apiKey = config.openrouter.apiKey,
    private readonly base = config.openrouter.base,
  ) {}

  get enabled(): boolean {
    return this.apiKey.length > 0;
  }

  /**
   * Boot-time connectivity check: a cheap authenticated GET /models. Confirms
   * the key is valid AND the network path (incl. any corporate proxy / Zscaler)
   * actually reaches openrouter.ai — so a silent "no LLM calls" surfaces as a
   * concrete error at startup instead of a mystery.
   */
  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    if (!this.enabled) return { ok: false, detail: "OPENROUTER_API_KEY is empty" };
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(`${this.base}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status}: ${text.slice(0, 160)}` };
      let count = 0;
      try {
        count = (JSON.parse(text) as { data?: unknown[] }).data?.length ?? 0;
      } catch {
        /* ignore body parse */
      }
      return { ok: true, detail: `reachable, ${count} models` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    } finally {
      clearTimeout(t);
    }
  }

  async chat(req: ChatRequest): Promise<string> {
    const timeout = req.timeoutMs ?? config.openrouter.timeoutMs;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.once(req, timeout);
      } catch (e) {
        lastErr = e;
        const msg = (e as Error).message;
        // Don't retry client errors (bad request / auth) — only transient ones.
        if (/\b(400|401|403)\b/.test(msg)) break;
        log.debug({ attempt, err: msg }, "chat attempt failed, retrying");
        await sleep(250 * (attempt + 1));
      }
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
