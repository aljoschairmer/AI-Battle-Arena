/**
 * Best-effort extraction of a JSON object from an LLM response. Models sometimes
 * wrap JSON in prose or ```json fences despite being asked not to; this digs the
 * object out so a stray backtick never costs us a decision.
 */
export function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  // Fast path: already clean JSON.
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  // Strip code fences.
  const fenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    return JSON.parse(fenced);
  } catch {
    /* fall through */
  }
  // Grab the outermost {...} span.
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(fenced.slice(start, end + 1));
    } catch {
      /* give up */
    }
  }
  throw new Error("no parseable JSON in model output");
}
