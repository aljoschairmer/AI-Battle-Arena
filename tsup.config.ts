import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    main: "src/main.ts",
    "scripts/generate-key": "scripts/generate-key.ts",
  },
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  sourcemap: true,
  splitting: false,
  dts: false,
  // Keep native/runtime deps external so they resolve from node_modules at runtime.
  external: ["ioredis", "ws", "pino", "pino-pretty"],
});
