# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project Overview

`@primandproper/platform-ts` is a TypeScript monorepo of isomorphic infrastructure
abstractions — the TypeScript sibling of `platform-go`. Each package exposes a stable
interface with swappable provider implementations selected by config. pnpm workspace,
Turborepo, ESM-only, Node 20+.

## Common Commands

```bash
pnpm install          # install workspace deps
pnpm build            # tsup build all packages (turbo)
pnpm typecheck        # tsc --noEmit all packages (turbo)
pnpm test             # vitest run all packages (turbo)
pnpm lint             # eslint all packages (turbo)
pnpm format           # prettier --write
pnpm format:check     # prettier --check
pnpm changeset        # record a version bump
```

Run one package's tests: `pnpm --filter @primandproper/cache test`.

## Package modality (the core architectural rule)

Every package is exactly one of three modalities. This drives its `package.json`
`exports`, its tsup entries, and its lint rules.

- **Universal** — pure logic, one build, no env-specific code. **No Node built-ins, no DOM
  globals.** e.g. `retry`. Single `src/index.ts`.
- **Isomorphic** — same import works on backend and frontend via conditional `exports`.
  Two build entries (`src/index.node.ts`, `src/index.browser.ts`) wiring different default
  providers behind an **identical** interface + factory signature, so call-site code is
  copy-paste portable between contexts. e.g. `observability`, `cache`.
- **Server-only** — Node bundle, `node`/`default` exports only (no `browser`). May use Node
  built-ins. e.g. `secrets`, `database`.

Conditional `exports` shape for isomorphic packages:

```jsonc
"exports": {
  ".": {
    "types": "./dist/index.d.ts",
    "browser": "./dist/index.browser.js",
    "node": "./dist/index.node.js",
    "default": "./dist/index.node.js"
  }
}
```

**Enforcement:** ESLint `no-restricted-imports` bans Node built-ins in every `*.browser.ts`
and in Universal packages. Do not reintroduce a Node import there — it breaks portability.

## Architecture patterns

- **Interface + multi-implementation:** a package defines its interface in a universal
  module (e.g. `cache.ts`), with provider implementations under `providers/`. Node-only
  providers are named `*.node.ts`, browser-only `*.browser.ts`; shared providers (memory,
  noop) carry no suffix and must stay universal.
- **Zod config + factory:** each package has `config.ts` with a Zod schema (replacing Go's
  `env:` tags + ozzo `ValidateWithContext`; defaults via `.default(...)`) and a
  `provide*(cfg, deps)` factory that switches on the provider — the analogue of Go's
  `Provide*()`. No DI container; compose factories explicitly.
- **Observability injected:** provider constructors take `{ logger, tracer, metrics }`.
  Guard with `ensureLogger(deps?.logger)` so a missing logger becomes a noop (mirrors Go's
  `EnsureLogger()`).
- **Optional over sentinels:** a cache miss is `undefined`, not a sentinel error. There is
  deliberately no shared `errors` package yet — error handling is an open design question.

## Testing

- Vitest. Tests live beside source as `*.test.ts`.
- Conformance suites run a provider-agnostic interface test against multiple providers
  (e.g. cache against memory + noop), proving the interface is implementation-independent.
- No mock-codegen; use `vi.fn()` or hand-written fakes.

## Imports

`eslint-plugin-import` enforces ordering: Node builtins → external → `@primandproper/*`
(internal) → relative, blank-line-separated, alphabetized.
