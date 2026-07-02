import { describe, expect, it } from "vitest";

import { checker, HealthRegistry, noopChecker, type CheckResult } from "./index.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("checker", () => {
  it("maps a resolving function to healthy with a measured duration", async () => {
    const result = await checker("ok", () => Promise.resolve()).check();
    expect(result.status).toBe("healthy");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it("maps a thrown error to unhealthy carrying the message", async () => {
    const result = await checker("boom", () =>
      Promise.reject(new Error("db unreachable")),
    ).check();
    expect(result.status).toBe("unhealthy");
    expect(result.error).toBe("db unreachable");
  });

  it("honors a Partial<CheckResult> return", async () => {
    const result = await checker("slow", () =>
      Promise.resolve<Partial<CheckResult>>({ status: "degraded", detail: "lagging" }),
    ).check();
    expect(result.status).toBe("degraded");
    expect(result.detail).toBe("lagging");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("reports unhealthy when the function exceeds timeoutMs", async () => {
    const result = await checker("hang", () => delay(50), { timeoutMs: 10 }).check();
    expect(result.status).toBe("unhealthy");
    expect(result.error).toMatch(/timed out/);
  });

  it("noopChecker is always healthy", async () => {
    const result = await noopChecker("placeholder").check();
    expect(result.status).toBe("healthy");
  });
});

describe("HealthRegistry", () => {
  it("reports healthy for an empty registry", async () => {
    const report = await new HealthRegistry().check();
    expect(report.status).toBe("healthy");
    expect(report.checks).toEqual({});
  });

  it("is healthy when every check is healthy", async () => {
    const registry = new HealthRegistry();
    registry.register(noopChecker("a"));
    registry.register(noopChecker("b"));
    const report = await registry.check();
    expect(report.status).toBe("healthy");
    expect(Object.keys(report.checks)).toEqual(["a", "b"]);
  });

  it("is degraded when a check is degraded but none are unhealthy", async () => {
    const registry = new HealthRegistry();
    registry.register(noopChecker("a"));
    registry.register(
      checker("b", () => Promise.resolve<Partial<CheckResult>>({ status: "degraded" })),
    );
    const report = await registry.check();
    expect(report.status).toBe("degraded");
  });

  it("is unhealthy when any check is unhealthy", async () => {
    const registry = new HealthRegistry();
    registry.register(
      checker("b", () => Promise.resolve<Partial<CheckResult>>({ status: "degraded" })),
    );
    registry.register(checker("c", () => Promise.reject(new Error("down"))));
    const report = await registry.check();
    expect(report.status).toBe("unhealthy");
    expect(report.checks.c?.status).toBe("unhealthy");
  });

  it("keys the report by every checker's name", async () => {
    const registry = new HealthRegistry();
    registry.register(noopChecker("alpha"));
    registry.register(noopChecker("beta"));
    const report = await registry.check();
    expect(Object.keys(report.checks).sort()).toEqual(["alpha", "beta"]);
  });

  it("last-wins on a duplicate name", async () => {
    const registry = new HealthRegistry();
    registry.register(noopChecker("dup"));
    registry.register(checker("dup", () => Promise.reject(new Error("replaced"))));
    expect(registry.checkers()).toHaveLength(1);
    const report = await registry.check();
    expect(report.checks.dup?.status).toBe("unhealthy");
  });

  it("runs checks concurrently", async () => {
    const registry = new HealthRegistry();
    registry.register(checker("a", () => delay(40)));
    registry.register(checker("b", () => delay(40)));
    registry.register(checker("c", () => delay(40)));
    const start = performance.now();
    const report = await registry.check();
    const elapsed = performance.now() - start;
    expect(report.status).toBe("healthy");
    expect(elapsed).toBeLessThan(120);
  });
});
