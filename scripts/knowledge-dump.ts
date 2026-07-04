/* eslint-disable no-console */
/**
 * Manual knowledge snapshot — `npm run knowledge:dump`.
 *
 * Dumps everything the bot has learned into KNOWLEDGE_DIR (default
 * data/knowledge/, committed to the repo):
 *   - the learned KV entries (Tuner policy + Analyst insights, per bot scope)
 *     read from the configured bus (BUS=redis reads the live Redis; with
 *     BUS=memory there is no cross-process KV, so only files are dumped),
 *   - every brain memory file (round history, opponent profiles, insights).
 *
 * The same dump is written automatically on every graceful shutdown
 * (SIGINT/SIGTERM) of the main process; this script exists for ad-hoc
 * snapshots while the fleet keeps running. Restore happens automatically on
 * the next start (missing-only; see src/shared/knowledge.ts).
 */
import { config } from "../src/config";
import { getBus } from "../src/bus";
import { dumpKnowledge, knowledgePaths } from "../src/shared/knowledge";

async function main(): Promise<void> {
  const bus = getBus();
  const scopes = [...new Set(["", ...config.arena.bots.map((b) => b.scope)])];
  const paths = knowledgePaths();
  const result = await dumpKnowledge(bus, scopes, paths);
  console.log(`knowledge dump -> ${paths.dir}`);
  console.log(`  kv entries:   ${result.kvKeys.length ? result.kvKeys.join(", ") : "(none — bus empty/unreachable)"}`);
  console.log(`  memory files: ${result.memoryFiles.length ? result.memoryFiles.join(", ") : "(none yet)"}`);
  await bus.close();
}

main().catch((e) => {
  console.error("knowledge dump failed:", (e as Error).message);
  process.exit(1);
});
