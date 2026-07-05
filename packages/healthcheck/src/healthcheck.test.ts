import { makeRecordingObserver, type Logger } from "@primandproper/observability";
import { describe, expect, it, vi } from "vitest";

import { checker, HealthRegistry, noopChecker, type CheckResult } from "./index.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A logger whose `warn`/`error` messages are recorded; chainable methods return itself. */
function recordingLogger(): { logger: Logger; warns: string[]; errors: string[] } {
  const warns: string[] = [];
  const errors: string[] = [];
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: (message) => {
      warns.push(message);
    },
    error: (message) => {
      errors.push(message);
    },
    with: () => logger,
    child: () => logger,
    withSpan: () => logger,
  };
  return { logger, warns, errors };
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

  it("propagates a caller-initiated abort instead of reporting unhealthy (HC-2)", async () => {
    const abortable = checker(
      "abortable",
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(signal.reason as Error);
            return;
          }
          signal?.addEventListener(
            "abort",
            () => {
              reject(signal.reason as Error);
            },
            { once: true },
          );
        }),
    );
    const controller = new AbortController();
    const pending = abortable.check(controller.signal);
    controller.abort();
    // The cancellation surfaces as an AbortError rather than a false "unhealthy" component.
    await expect(pending).rejects.toHaveProperty("name", "AbortError");
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

  // HC-1: a checker built without its own timeoutMs must not hang the whole report forever.
  it("bounds a hanging checker with the registry deadline", async () => {
    const registry = new HealthRegistry({}, { checkTimeoutMs: 20 });
    registry.register(noopChecker("fast"));
    registry.register(checker("hang", () => new Promise<void>(() => undefined))); // never resolves

    const start = performance.now();
    const report = await registry.check();
    const elapsed = performance.now() - start;

    expect(report.status).toBe("unhealthy");
    expect(report.checks.hang?.status).toBe("unhealthy");
    expect(report.checks.hang?.error).toMatch(/registry deadline/);
    expect(report.checks.fast?.status).toBe("healthy");
    expect(elapsed).toBeLessThan(1_000); // did not hang on the never-resolving checker
  });

  it("can disable the registry deadline with checkTimeoutMs: 0", async () => {
    const registry = new HealthRegistry({}, { checkTimeoutMs: 0 });
    registry.register(checker("slow", () => delay(30)));
    const report = await registry.check();
    expect(report.status).toBe("healthy"); // 30ms check is not cut off
  });

  // INST-2: a failing component must be visible in the logs, not silent.
  it("logs an unhealthy check at error naming the check", async () => {
    const { logger, warns, errors } = recordingLogger();
    const registry = new HealthRegistry({ logger });
    registry.register(noopChecker("ok"));
    registry.register(checker("db", () => Promise.reject(new Error("db unreachable"))));
    await registry.check();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("db");
    expect(errors[0]).toContain("unhealthy");
    expect(warns).toHaveLength(0);
  });

  it("logs a degraded check at warn naming the check", async () => {
    const { logger, warns, errors } = recordingLogger();
    const registry = new HealthRegistry({ logger });
    registry.register(
      checker("cache", () =>
        Promise.resolve<Partial<CheckResult>>({ status: "degraded", detail: "lagging" }),
      ),
    );
    await registry.check();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("cache");
    expect(warns[0]).toContain("degraded");
    expect(errors).toHaveLength(0);
  });

  it("keeps a timed-out check unhealthy and logs it (HC-1 preserved)", async () => {
    const { logger, errors } = recordingLogger();
    const registry = new HealthRegistry({ logger }, { checkTimeoutMs: 20 });
    registry.register(checker("hang", () => new Promise<void>(() => undefined)));
    const report = await registry.check();
    expect(report.checks.hang?.status).toBe("unhealthy");
    expect(report.checks.hang?.error).toMatch(/registry deadline/);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("hang");
  });

  it("stays quiet on the logs when every check is healthy", async () => {
    const { logger, warns, errors } = recordingLogger();
    const registry = new HealthRegistry({ logger });
    registry.register(noopChecker("a"));
    registry.register(noopChecker("b"));
    await registry.check();
    expect(warns).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it("opens a span per check tagged with the check name and status", async () => {
    const observer = makeRecordingObserver();
    const registry = new HealthRegistry({ observer });
    registry.register(noopChecker("a"));
    registry.register(checker("b", () => Promise.reject(new Error("down"))));
    await registry.check();

    expect(observer.runs.map((r) => r.operation)).toEqual(["check", "check"]);
    expect(observer.data().check).toBeDefined();
    const statuses = observer.forKey("status").map((o) => o.value);
    expect(statuses).toContain("healthy");
    expect(statuses).toContain("unhealthy");
    const checkNames = observer.forKey("check").map((o) => o.value);
    expect(checkNames).toContain("a");
    expect(checkNames).toContain("b");
  });
});
