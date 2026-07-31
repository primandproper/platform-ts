/**
 * Node entry: the client half (key minting, fingerprints, the `fetch` wrapper) plus the
 * server-side {@link IdempotencyManager} the browser entry deliberately does not carry.
 *
 * The asymmetry is the point of the split — see the package README. A browser has no record
 * store and no distributed lock, so a manager there could only pretend; a server, meanwhile,
 * needs the client half too, since it is a client of other services.
 */
export * from "./client.js";
export * from "./config.js";
export * from "./fingerprint.js";
export * from "./instruments.js";
export * from "./key.js";
export * from "./record.js";
export * from "./manager.node.js";
export * from "./with-lock.node.js";
