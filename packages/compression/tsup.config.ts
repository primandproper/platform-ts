import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { "index.node": "src/index.node.ts" },
    platform: "node",
    format: ["esm"],
    dts: true,
    sourcemap: true,
    treeshake: true,
    clean: true,
  },
  {
    entry: { "index.browser": "src/index.browser.ts" },
    platform: "browser",
    format: ["esm"],
    dts: true,
    sourcemap: true,
    treeshake: true,
    clean: false,
  },
]);
