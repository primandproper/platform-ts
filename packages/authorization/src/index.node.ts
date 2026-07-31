/**
 * Node entry: the checking half the browser also gets, plus policy resolution and server
 * enforcement.
 *
 * The asymmetry is the design. Checking is synchronous, infallible, and identical on both sides;
 * resolving role names to permissions may touch a database and stays on the server, and so does
 * deciding whether to admit a request at all. A caller resolves once when it builds a session and
 * checks many times per request against the resulting {@link Grants}.
 */
export * from "./enforcement.js";
export * from "./errors.js";
export * from "./grants.js";
export * from "./instruments.js";
export * from "./permission.js";
export * from "./policy.js";
export * from "./requirements.js";
export { StaticPolicyResolver } from "./providers/static.js";
