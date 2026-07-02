import { defineConfig } from "tsup";

// Isomorphic package: two independent builds behind conditional exports. The Node build
// may pull in pino; the browser build is platform-constrained so Node built-ins can never
// leak in.
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
