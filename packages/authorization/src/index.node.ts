/**
 * Node entry: the checking half the browser also gets, plus policy resolution.
 *
 * The asymmetry is the design. Checking is synchronous, infallible, and identical on both sides;
 * resolving role names to permissions may touch a database and stays on the server. A caller
 * resolves once when it builds a session and checks many times per request against the resulting
 * {@link Grants}.
 */
export * from "./errors.js";
export * from "./grants.js";
export * from "./permission.js";
export * from "./policy.js";
export { StaticPolicyResolver } from "./providers/static.js";
