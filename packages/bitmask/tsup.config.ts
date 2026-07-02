import { defineConfig } from "tsup";

// Universal package: a single platform-neutral build.
export default defineConfig({
  entry: { index: "src/index.ts" },
  platform: "neutral",
  format: ["esm"],
  dts: true,
  sourcemap: true,
  treeshake: true,
  clean: true,
});
