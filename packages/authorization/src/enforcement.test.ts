import type { MeterProvider, ObservabilityDeps } from "@primandproper/observability";
import { describe, expect, it, vi } from "vitest";

import { newEnforcer, type Decision } from "./enforcement.js";
import { isPermissionDenied, PermissionDeniedError } from "./errors.js";
import {
  allowAll,
  denyAll,
  newGrants,
  type Grants,
  type GrantsExtractor,
} from "./grants.js";
import { PermissionSet } from "./permission.js";
import { newRequirements } from "./requirements.js";

/** The request context these tests enforce over: whatever authority the caller carries. */
interface Ctx {
  grants?: Grants;
  route?: string;
}

const extract: GrantsExtractor<Ctx> = (ctx) => ctx.grants;

function holding(...perms: readonly string[]): Ctx {
  return { grants: newGrants(new PermissionSet(perms)) };
}

/** A meter provider that tallies counter `add`s by `${instrument}:${key}`. */
function recordingMeter(): { provider: MeterProvider; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  const counter = (name: string) => ({
    add: (value: number, attributes?: { key?: string }) => {
      const tally = `${name}:${attributes?.key ?? ""}`;
      counts[tally] = (counts[tally] ?? 0) + value;
    },
  });
  const meter = {
    createCounter: (name: string) => counter(name),
    createUpDownCounter: (name: string) => counter(name),
    createHistogram: () => ({ record: () => undefined }),
    createGauge: () => ({ record: () => undefined }),
  };
  return { provider: { getMeter: () => meter } as unknown as MeterProvider, counts };
}

/** A logger that records what was said at each level. */
function recordingLogger(): {
  deps: ObservabilityDeps;
  errors: string[];
  infos: string[];
} {
  const errors: string[] = [];
  const infos: string[] = [];
  const logger = {
    debug: vi.fn(),
    info: (message: string) => infos.push(message),
    warn: vi.fn(),
    error: (message: string) => errors.push(message),
    with: (): unknown => logger,
    child: (): unknown => logger,
    withSpan: (): unknown => logger,
  };
  return { deps: { logger: logger as never }, errors, infos };
}

/** Runs a middleware and reports whether it reached the handler. */
async function run(
  middleware: (ctx: Ctx, next: () => unknown) => Promise<void>,
  ctx: Ctx,
): Promise<{ reached: boolean; err: unknown }> {
  let reached = false;
  try {
    await middleware(ctx, () => {
      reached = true;
    });
  } catch (err) {
    return { reached, err };
  }
  return { reached, err: undefined };
}

describe("Enforcer.decide", () => {
  it("admits a request holding every required permission", () => {
    const enforcer = newEnforcer({ extract });
    const decision = enforcer.decide(holding("things.read", "things.write"), [
      "things.read",
      "things.write",
    ]);

    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("allowed");
  });

  it("denies a request holding only a subset, and says what was missing", () => {
    const enforcer = newEnforcer({ extract });
    const decision = enforcer.decide(holding("things.read"), [
      "things.read",
      "things.write",
    ]);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("missing-permissions");
    expect(decision.missing).toEqual(["things.write"]);
  });

  it("denies when no authority could be determined", () => {
    const enforcer = newEnforcer({ extract });
    const decision = enforcer.decide({}, ["things.read"]);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("no-grants");
  });

  it("denies grants that permit nothing", () => {
    const enforcer = newEnforcer({ extract });
    expect(enforcer.decide({ grants: denyAll() }, ["things.read"]).allowed).toBe(false);
  });

  it("denies an empty requirement list rather than vacuously allowing it", () => {
    // The middleware row of the empty-list matrix. `Grants.hasAll([])` is honestly `true` — set
    // algebra — but a guard installed with an empty list is far more likely a list that came back
    // empty from configuration than an intent to admit everyone.
    const enforcer = newEnforcer({ extract });
    const decision = enforcer.decide(holding("things.read"), []);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("empty-requirement");
  });

  it("admits everything for allowAll grants — but still denies an empty requirement", () => {
    // The escape hatch turns the policy off, not the guard against a requirement list that
    // reached zero length by accident.
    const enforcer = newEnforcer({ extract });

    expect(enforcer.decide({ grants: allowAll() }, ["anything.at.all"]).allowed).toBe(
      true,
    );
    expect(enforcer.decide({ grants: allowAll() }, []).reason).toBe("empty-requirement");
  });
});

describe("Enforcer.require", () => {
  it("reaches the handler for an authorized request", async () => {
    const enforcer = newEnforcer({ extract });
    const { reached, err } = await run(
      enforcer.require("things.read"),
      holding("things.read"),
    );

    expect(reached).toBe(true);
    expect(err).toBeUndefined();
  });

  it("throws a permission denial instead of reaching the handler", async () => {
    // Denial travels as an error with a stable code so the framework's own error hook turns it
    // into a 403 — identical to a handler that threw the same error itself.
    const enforcer = newEnforcer({ extract });
    const { reached, err } = await run(
      enforcer.require("things.write"),
      holding("things.read"),
    );

    expect(reached).toBe(false);
    expect(isPermissionDenied(err)).toBe(true);
  });

  it("does not disclose the permission taxonomy in the message", () => {
    // The security assertion: which permission was missing goes to the log and the span, and stops
    // there. Naming it in a response tells an unauthorized caller what to go looking for.
    const err = new PermissionDeniedError(["billing.refund"]);

    expect(err.message).toBe("permission denied");
    expect(err.message).not.toContain("billing.refund");
    expect(err.missing).toEqual(["billing.refund"]);
  });

  it("denies a route guarded with no permissions", async () => {
    const enforcer = newEnforcer({ extract });
    const { reached, err } = await run(enforcer.require(), holding("things.read"));

    expect(reached).toBe(false);
    expect(isPermissionDenied(err)).toBe(true);
  });

  it("copies the permission list, so a later mutation cannot alter the requirement", async () => {
    const enforcer = newEnforcer({ extract });
    const perms = ["things.read"];
    const middleware = enforcer.require(...perms);
    perms[0] = "things.write";

    const { reached } = await run(middleware, holding("things.read"));

    expect(reached).toBe(true);
  });
});

describe("Enforcer.enforce", () => {
  const requirements = newRequirements()
    .require("GET /things/:id", "things.read")
    .markPublic("GET /healthz")
    .build();

  const keyOf = (ctx: Ctx): string | undefined => ctx.route;

  it("admits a request satisfying its declared requirement", async () => {
    const enforcer = newEnforcer({ extract, requirements });
    const { reached } = await run(enforcer.enforce(keyOf), {
      ...holding("things.read"),
      route: "GET /things/:id",
    });

    expect(reached).toBe(true);
  });

  it("admits a public route without consulting grants at all", async () => {
    const enforcer = newEnforcer({ extract, requirements });
    const { reached } = await run(enforcer.enforce(keyOf), { route: "GET /healthz" });

    expect(reached).toBe(true);
  });

  it("denies an undeclared route", async () => {
    // Fail closed: being public is a declaration, never an omission, so forgetting to declare a
    // route produces a denial rather than an opening.
    const enforcer = newEnforcer({ extract, requirements });
    const { reached, err } = await run(enforcer.enforce(keyOf), {
      ...holding("things.read", "things.admin"),
      route: "DELETE /things/:id",
    });

    expect(reached).toBe(false);
    expect(isPermissionDenied(err)).toBe(true);
  });

  it("denies a context whose key could not be derived", async () => {
    const enforcer = newEnforcer({ extract, requirements });
    const { reached, err } = await run(enforcer.enforce(keyOf), holding("things.read"));

    expect(reached).toBe(false);
    expect(isPermissionDenied(err)).toBe(true);
  });

  it("reports the key on the decision", () => {
    const enforcer = newEnforcer({ extract, requirements });
    const decision = enforcer.decideDeclared(holding("things.read"), "GET /things/:id");

    expect(decision.key).toBe("GET /things/:id");
  });

  it("refuses to decide from a table it was not given", () => {
    const enforcer = newEnforcer({ extract });
    expect(() =>
      enforcer.decideDeclared(holding("things.read"), "GET /things/:id"),
    ).toThrow(TypeError);
  });
});

describe("Enforcer.authorize", () => {
  it("returns for an authorized request and throws otherwise", () => {
    const enforcer = newEnforcer({ extract });

    expect(() => {
      enforcer.authorize(holding("things.read"), "things.read");
    }).not.toThrow();
    expect(() => {
      enforcer.authorize(holding("things.read"), "things.write");
    }).toThrow();
  });

  it("denies when called with no permissions", () => {
    const enforcer = newEnforcer({ extract });
    expect(() => {
      enforcer.authorize(holding("things.read"));
    }).toThrow();
  });
});

describe("Enforcer audit-only mode", () => {
  const requirements = newRequirements().require("GET /things", "things.read").build();

  it("records the denial but lets the request through", async () => {
    const { provider, counts } = recordingMeter();
    const enforcer = newEnforcer({
      extract,
      requirements,
      auditOnly: true,
      deps: { metrics: provider },
    });

    const decision = enforcer.decideDeclared(holding("other.thing"), "GET /things");
    const { reached, err } = await run(
      enforcer.enforce((ctx) => ctx.route),
      {
        ...holding("other.thing"),
        route: "GET /things",
      },
    );

    // The decision stays honest; only what the enforcer does about it changes.
    expect(decision.allowed).toBe(false);
    expect(reached).toBe(true);
    expect(err).toBeUndefined();
    expect(counts["authorization.denials:GET /things"]).toBe(2);
  });

  it("announces itself at construction, since it is the only mode that admits the unauthorized", () => {
    const { deps, infos } = recordingLogger();
    newEnforcer({ extract, auditOnly: true, deps });

    expect(infos.join("\n")).toContain("audit-only");
  });

  it("is off unless asked for", () => {
    expect(newEnforcer({ extract }).isAuditOnly()).toBe(false);
  });
});

describe("Enforcer instruments", () => {
  const requirements = newRequirements()
    .require("GET /things", "things.read")
    .markPublic("GET /healthz")
    .build();

  it("counts every check, tagged by the declared key", () => {
    const { provider, counts } = recordingMeter();
    const enforcer = newEnforcer({ extract, requirements, deps: { metrics: provider } });

    enforcer.decideDeclared(holding("things.read"), "GET /things");
    enforcer.decideDeclared({}, "GET /healthz");

    expect(counts["authorization.checks:GET /things"]).toBe(1);
    expect(counts["authorization.checks:GET /healthz"]).toBe(1);
    expect(counts["authorization.denials:GET /things"]).toBeUndefined();
  });

  it("separates the wiring bugs from an overreaching caller", () => {
    // These three mean the service is enforcing something other than what its author intended, and
    // they are the ones worth alerting on. An ordinary denial is just traffic.
    const { provider, counts } = recordingMeter();
    const enforcer = newEnforcer({ extract, requirements, deps: { metrics: provider } });

    enforcer.decideDeclared({}, "GET /things"); // authentication did not run
    enforcer.decideDeclared(holding("things.read"), "GET /admin"); // nobody declared it
    enforcer.decide(holding("things.read"), []); // guarded with an empty list
    enforcer.decideDeclared(holding("other.thing"), "GET /things"); // an actual overreach

    expect(counts["authorization.missing_grants:GET /things"]).toBe(1);
    expect(counts["authorization.undeclared:GET /admin"]).toBe(1);
    expect(counts["authorization.empty_requirements:"]).toBe(1);
    expect(counts["authorization.denials:GET /things"]).toBe(2);
  });

  it("logs the wiring bugs at error level and an overreach at debug", () => {
    const { deps, errors } = recordingLogger();
    const enforcer = newEnforcer({ extract, requirements, deps });

    enforcer.decideDeclared({}, "GET /things");
    enforcer.decideDeclared(holding("things.read"), "GET /admin");
    enforcer.decide(holding("things.read"), []);
    enforcer.decideDeclared(holding("other.thing"), "GET /things");

    expect(errors).toHaveLength(3);
    expect(errors.join("\n")).toContain("no grants available");
  });
});

describe("Enforcer decisions", () => {
  it("hands out a missing list that cannot be edited back into the decision", () => {
    const enforcer = newEnforcer({ extract });
    const decision: Decision = enforcer.decide(holding(), ["a", "b"]);

    expect(decision.missing).toEqual(["a", "b"]);
    (decision.missing as string[]).length = 0;

    expect(enforcer.decide(holding(), ["a", "b"]).missing).toEqual(["a", "b"]);
  });
});
