/**
 * Discrimination keys off a registered brand symbol rather than `instanceof`, so a guard still
 * holds when the error crosses a bundle/realm boundary or two copies of this package coexist —
 * the failure mode `instanceof` quietly has across dual-build output and duplicated dependencies.
 */
const BRAND = Symbol.for("@primandproper/errors.PlatformError");

/**
 * The base for typed platform errors. Carries an open string `code` (callers namespace their own,
 * e.g. `"secrets/missing"` — there is deliberately no central code taxonomy) and the standard
 * `cause` chain via {@link ErrorOptions}.
 */
export class PlatformError extends Error {
  readonly code: string;
  readonly [BRAND] = true as const;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PlatformError";
    this.code = code;
    // Restore the prototype chain when a subclass is down-leveled, so `instanceof` still works
    // for callers who reach for it even though our own guard does not.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** True when `err` is a {@link PlatformError} (any instance/realm); narrows by `code` when given. */
export function isPlatformError(err: unknown, code?: string): err is PlatformError {
  return (
    typeof err === "object" &&
    err !== null &&
    BRAND in err &&
    (code === undefined || (err as PlatformError).code === code)
  );
}
