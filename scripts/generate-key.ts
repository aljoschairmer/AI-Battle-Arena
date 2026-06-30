import { ArenaRest } from "../src/arena/rest";

/**
 * Generate an arena API key (no signup required) and print it.
 *
 *   npm run keygen
 *
 * Copy the printed `api_key` into your .env as ARENA_API_KEY.
 */
async function main(): Promise<void> {
  const rest = new ArenaRest();
  const res = await rest.generateKey();
  // eslint-disable-next-line no-console
  console.log(
    [
      "",
      "  AI Battle Arena — new API key",
      "  --------------------------------------------------",
      `  api_key : ${res.api_key}`,
      `  bot_id  : ${res.bot_id}`,
      `  created : ${res.created_at}`,
      "",
      "  Add to .env:",
      `  ARENA_API_KEY=${res.api_key}`,
      "",
      "  Store it safely — it cannot be recovered.",
      "",
    ].join("\n"),
  );
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("Failed to generate key:", (e as Error).message);
  process.exit(1);
});
