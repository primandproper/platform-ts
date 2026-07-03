import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  platform: "node",
  format: ["esm"],
  dts: true,
  sourcemap: true,
  treeshake: true,
  clean: true,
});
