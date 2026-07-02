import { afterEach, describe, expect, it } from "vitest";

import { configureVersion, formatJSON, getVersion, resetVersion } from "./index.js";

afterEach(() => {
  resetVersion();
});

describe("getVersion", () => {
  it("returns unknown for every unset field", () => {
    expect(getVersion()).toStrictEqual({
      version: "unknown",
      commitHash: "unknown",
      commitTime: "unknown",
      buildTime: "unknown",
    });
  });

  it("returns configured values when populated", () => {
    configureVersion({
      version: "v1.2.3",
      commitHash: "abc123",
      commitTime: "2026-01-01T00:00:00Z",
      buildTime: "2026-01-02T00:00:00Z",
    });

    expect(getVersion()).toStrictEqual({
      version: "v1.2.3",
      commitHash: "abc123",
      commitTime: "2026-01-01T00:00:00Z",
      buildTime: "2026-01-02T00:00:00Z",
    });
  });

  it("merges successive configure calls and leaves unset fields unknown", () => {
    configureVersion({ version: "v1.0.0" });
    configureVersion({ commitHash: "deadbeef" });

    const info = getVersion();
    expect(info.version).toBe("v1.0.0");
    expect(info.commitHash).toBe("deadbeef");
    expect(info.commitTime).toBe("unknown");
  });

  it("treats an empty string as unset", () => {
    configureVersion({ version: "" });
    expect(getVersion().version).toBe("unknown");
  });
});

describe("formatJSON", () => {
  it("emits indented snake_case keys for platform-go parity", () => {
    configureVersion({
      version: "v1.2.3",
      commitHash: "abc123",
      commitTime: "2026-01-01T00:00:00Z",
      buildTime: "2026-01-02T00:00:00Z",
    });

    expect(JSON.parse(formatJSON())).toStrictEqual({
      version: "v1.2.3",
      commit_hash: "abc123",
      commit_time: "2026-01-01T00:00:00Z",
      build_time: "2026-01-02T00:00:00Z",
    });
    expect(formatJSON()).toContain('  "version": "v1.2.3"');
  });

  it("serializes unknowns when nothing is configured", () => {
    expect(JSON.parse(formatJSON())).toStrictEqual({
      version: "unknown",
      commit_hash: "unknown",
      commit_time: "unknown",
      build_time: "unknown",
    });
  });
});
