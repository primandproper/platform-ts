const UNKNOWN = "unknown";

/** VCS and build metadata. The TypeScript sibling of platform-go's `version.Info`. */
export interface VersionInfo {
  version: string;
  commitHash: string;
  commitTime: string;
  buildTime: string;
}

/**
 * Bundle-time injection points — the analogue of Go's `-ldflags -X`. A consuming
 * app's bundler (esbuild/tsup/Vite) can `define` these to string literals:
 *
 *   define: { __PLATFORM_VERSION__: JSON.stringify(process.env.VERSION) }
 *
 * Accessed only through `typeof` so an unreplaced reference stays safe at runtime
 * (in plain JS, `typeof undeclaredIdent` is "undefined" rather than a ReferenceError),
 * which keeps the package Universal — no `process`, no Node built-ins.
 */
declare const __PLATFORM_VERSION__: string | undefined;
declare const __PLATFORM_COMMIT_HASH__: string | undefined;
declare const __PLATFORM_COMMIT_TIME__: string | undefined;
declare const __PLATFORM_BUILD_TIME__: string | undefined;

/** Bundle-define candidates: every field present, each possibly unreplaced (`undefined`). */
type InjectedInfo = Record<keyof VersionInfo, string | undefined>;

function fromDefine(): InjectedInfo {
  return {
    version:
      typeof __PLATFORM_VERSION__ !== "undefined" ? __PLATFORM_VERSION__ : undefined,
    commitHash:
      typeof __PLATFORM_COMMIT_HASH__ !== "undefined"
        ? __PLATFORM_COMMIT_HASH__
        : undefined,
    commitTime:
      typeof __PLATFORM_COMMIT_TIME__ !== "undefined"
        ? __PLATFORM_COMMIT_TIME__
        : undefined,
    buildTime:
      typeof __PLATFORM_BUILD_TIME__ !== "undefined"
        ? __PLATFORM_BUILD_TIME__
        : undefined,
  };
}

let configured: Partial<VersionInfo> = {};

/**
 * Sets version metadata at startup, the runtime injection path for environments that
 * can't replace bundle-time defines (or prefer not to). Merges over prior calls, and
 * takes precedence over any bundle-time define. Source the values however you like:
 * a generated file, env vars read in your own boot code, a fetch, etc.
 */
export function configureVersion(info: Partial<VersionInfo>): void {
  configured = { ...configured, ...info };
}

/** Clears any runtime-configured metadata. Primarily for tests. */
export function resetVersion(): void {
  configured = {};
}

function pick(...candidates: (string | undefined)[]): string {
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== "") {
      return candidate;
    }
  }
  return UNKNOWN;
}

/**
 * Returns the current version info, resolving each field by precedence —
 * runtime `configureVersion` → bundle-time define → `"unknown"`. Mirrors Go's
 * `version.Get()`, including the `"unknown"` fallback for any unset field.
 */
export function getVersion(): VersionInfo {
  const injected = fromDefine();
  return {
    version: pick(configured.version, injected.version),
    commitHash: pick(configured.commitHash, injected.commitHash),
    commitTime: pick(configured.commitTime, injected.commitTime),
    buildTime: pick(configured.buildTime, injected.buildTime),
  };
}

/**
 * Serializes the current version info as indented JSON, using snake_case keys to
 * stay wire-compatible with platform-go's `WriteJSON`. Returns the string rather
 * than writing to stdout, so the caller decides the sink (Universal: no `process`).
 */
export function formatJSON(): string {
  const info = getVersion();
  return JSON.stringify(
    {
      version: info.version,
      commit_hash: info.commitHash,
      commit_time: info.commitTime,
      build_time: info.buildTime,
    },
    null,
    2,
  );
}
