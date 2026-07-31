// @ts-check
import importPlugin from "eslint-plugin-import";
import tseslint from "typescript-eslint";

/**
 * House lint rules. The interesting part is the environment-boundary rule: code that
 * must run in the browser (every `*.browser.ts`) and every Universal package must not
 * reach for Node built-ins. This is the TypeScript analogue of the Go repo's `depguard`
 * ban and is what mechanically guarantees isomorphic/universal code stays portable.
 */

const nodeBuiltinBan = {
  patterns: [
    {
      group: ["node:*", "fs", "path", "crypto", "os", "stream", "ioredis", "pino"],
      message:
        "Node-only imports are banned in browser/universal code — keep this module portable.",
    },
  ],
};

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/*.config.*"] },
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    plugins: { import: importPlugin },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Noop providers (loggers, caches) legitimately have empty method bodies.
      "@typescript-eslint/no-empty-function": ["error", { allow: ["methods"] }],
      // Many providers wrap synchronous backends behind an async interface.
      "@typescript-eslint/require-await": "off",
      "import/order": [
        "error",
        {
          groups: ["builtin", "external", "internal", "parent", "sibling", "index"],
          pathGroups: [
            { pattern: "@primandproper/**", group: "internal", position: "before" },
          ],
          "newlines-between": "always",
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],
    },
  },
  {
    // Browser entry points and every Universal package must stay Node-free.
    files: [
      "**/*.browser.ts",
      "packages/errors/**/*.ts",
      "packages/retry/**/*.ts",
      "packages/identifiers/**/*.ts",
      "packages/numbers/**/*.ts",
      "packages/bitmask/**/*.ts",
      "packages/circuitbreaking/**/*.ts",
      "packages/encoding/**/*.ts",
      "packages/fake/**/*.ts",
    ],
    rules: {
      "no-restricted-imports": ["error", nodeBuiltinBan],
    },
  },
  {
    // eventcapture is isomorphic: everything except the `*.node.ts` providers (and the tests
    // that drive them) is shared by both builds, so the shared core must stay Node-free even
    // though the package as a whole is not Universal.
    files: ["packages/eventcapture/src/**/*.ts"],
    ignores: [
      "packages/eventcapture/src/**/*.node.ts",
      "packages/eventcapture/src/**/*.test.ts",
    ],
    rules: {
      "no-restricted-imports": ["error", nodeBuiltinBan],
    },
  },
  {
    // authorization is isomorphic and, unusually, every module in it is portable: the whole
    // checking half ships to the browser, and even the static resolver runs without I/O. Only
    // the split of what each entry point re-exports keeps resolution server-side, so the ban
    // applies to the package as a whole rather than to a `*.node.ts` subset.
    files: ["packages/authorization/src/**/*.ts"],
    ignores: ["packages/authorization/src/**/*.test.ts"],
    rules: {
      "no-restricted-imports": ["error", nodeBuiltinBan],
    },
  },
  {
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
    },
  },
);
