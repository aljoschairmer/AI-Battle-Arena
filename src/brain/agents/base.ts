import type { ZodType, ZodTypeDef } from "zod";
import { child } from "../../shared/logger";
import { extractJson } from "../../shared/json";
import { openrouter } from "../openrouter";

const log = child("agent");

/**
 * Base class for an LLM agent. Each concrete agent declares its model, output
 * schema, and prompts; the base handles the call, JSON extraction, schema
 * validation, latency logging, and — crucially — never throwing. A failed agent
 * returns null and the orchestrator falls back to deterministic logic, so the
 * bot keeps fighting no matter what the LLM does.
 */
export abstract class Agent<TInput, TOutput> {
  abstract readonly name: string;
  protected abstract readonly model: string;
  // Input type param is `any` so schemas using `.default()` (whose parsed input
  // differs from their output) still satisfy the bound. safeParse validates at
  // runtime regardless.
  protected abstract readonly schema: ZodType<TOutput, ZodTypeDef, any>;
  protected temperature = 0.4;
  protected maxTokens = 450;

  protected abstract systemPrompt(): string;
  protected abstract userPrompt(input: TInput): string;

  async run(input: TInput): Promise<TOutput | null> {
    if (!openrouter.enabled) return null;
    const started = Date.now();
    try {
      const content = await openrouter.chat({
        model: this.model,
        system: this.systemPrompt(),
        user: this.userPrompt(input),
        temperature: this.temperature,
        maxTokens: this.maxTokens,
        json: true,
      });
      const json = extractJson(content);
      const parsed = this.schema.safeParse(json);
      if (!parsed.success) {
        log.warn(
          { agent: this.name, issues: parsed.error.issues.slice(0, 3) },
          "agent output failed validation",
        );
        return null;
      }
      log.debug({ agent: this.name, ms: Date.now() - started }, "agent ok");
      return parsed.data;
    } catch (e) {
      log.warn({ agent: this.name, err: (e as Error).message }, "agent failed");
      return null;
    }
  }
}
