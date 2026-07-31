/**
 * Browser entry: the checking half — permission sets, grants, and the errors they raise.
 *
 * This is the half that decides which controls a UI renders, and it is deliberately the *same*
 * code the server checks with, so the two cannot drift. A session payload hydrates it directly
 * through {@link grantsFromJSON}; every check is synchronous, so it is usable in a render path
 * without a suspense boundary or a loading state.
 *
 * Policy resolution is absent here rather than stubbed: resolving role names to permissions may
 * do I/O and belongs to the server, which then hands the browser the resolved set. Reaching for
 * `StaticPolicyResolver` in browser-resolved code is a type error, which is the intended
 * feedback — a browser that could resolve policy would be a browser that holds it.
 */
export * from "./errors.js";
export * from "./grants.js";
export * from "./permission.js";
