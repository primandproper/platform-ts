/**
 * Names an action a principal may be authorized to perform.
 *
 * It is a bare string so consumers declare their own vocabulary as ordinary constants:
 *
 * ```ts
 * export const CreateRecipes: Permission = "create.recipes";
 * ```
 *
 * A consumer with an existing permission union adopts this one with a type alias
 * (`type Permission = import("@primandproper/authorization").Permission`), which leaves every
 * existing constant, object key, and `switch` compiling unchanged.
 */
export type Permission = string;

/**
 * An immutable set of permissions.
 *
 * Every check is synchronous, allocation-free, and cannot fail — see the package README for why
 * that is the property the whole design exists to protect. An empty set grants nothing, which is
 * load-bearing rather than defensive: a principal with no membership in some scope is represented
 * by an empty set rather than an absent entry, so "no grants here" needs no special case at any
 * call site.
 */
export class PermissionSet {
  readonly #perms: ReadonlySet<Permission>;

  /**
   * Builds a set containing `perms`. Duplicates collapse and empty strings are dropped. The set
   * copies its input, so mutating the caller's array afterwards cannot change it.
   */
  constructor(perms: Iterable<Permission> = []) {
    const set = new Set<Permission>();
    for (const p of perms) {
      if (p !== "") {
        set.add(p);
      }
    }
    this.#perms = set;
  }

  /** Reports whether `perm` is in the set. */
  has(perm: Permission): boolean {
    return perm !== "" && this.#perms.has(perm);
  }

  /**
   * Reports whether every permission in `perms` is in the set.
   *
   * **`hasAll()` with no permissions is vacuously `true`.** That is the mathematically honest
   * answer for a universal quantifier, and it is a live hazard: a requirement list that
   * accidentally resolved to zero permissions would authorize everyone. Set algebra wins here and
   * the guard belongs at each declaration site, so the three places a permission list is declared
   * answer the empty case differently on purpose:
   *
   * | site | empty list |
   * | --- | --- |
   * | `PermissionSet.hasAll()` / `Grants.hasAll()` | `true` — set algebra |
   * | server enforcement middleware | denies — an empty list is far more likely a bug |
   * | a frozen requirements table | refuses to build at all |
   *
   * "Empty means allow" is therefore only ever safe with a list you wrote literally. Anything
   * derived from configuration, a database, or a lookup must be checked for emptiness before it
   * reaches here.
   *
   * **The last two rows describe an enforcement layer this package does not ship yet** — see
   * "Not ported" in the README. Until it lands, guarding a derived list is the caller's job, and
   * this is the hazard to guard against.
   */
  hasAll(perms: Iterable<Permission>): boolean {
    for (const p of perms) {
      if (!this.has(p)) {
        return false;
      }
    }
    return true;
  }

  /** Reports whether any permission in `perms` is in the set. With no permissions: `false` — there is no witness. */
  hasAny(perms: Iterable<Permission>): boolean {
    for (const p of perms) {
      if (this.has(p)) {
        return true;
      }
    }
    return false;
  }

  /** The number of permissions in the set. */
  get size(): number {
    return this.#perms.size;
  }

  /** Reports whether the set grants nothing. */
  isEmpty(): boolean {
    return this.#perms.size === 0;
  }

  /**
   * The set's permissions in sorted order. The order is deterministic so that encodings, golden
   * files, and equality checks over serialized forms are stable across runs.
   */
  values(): Permission[] {
    return [...this.#perms].sort();
  }

  /** Iterates the set in sorted order. */
  [Symbol.iterator](): IterableIterator<Permission> {
    return this.values()[Symbol.iterator]();
  }

  /** A new set containing everything in this set and in `others`. */
  union(...others: readonly PermissionSet[]): PermissionSet {
    const merged = new Set(this.#perms);
    for (const other of others) {
      for (const p of other.#perms) {
        merged.add(p);
      }
    }
    return new PermissionSet(merged);
  }

  /** Reports whether every permission in this set is also in `other`. The empty set is a subset of everything. */
  isSubsetOf(other: PermissionSet): boolean {
    for (const p of this.#perms) {
      if (!other.has(p)) {
        return false;
      }
    }
    return true;
  }

  /** Reports whether this set and `other` contain exactly the same permissions. */
  equals(other: PermissionSet): boolean {
    return this.size === other.size && this.isSubsetOf(other);
  }

  /**
   * Encodes the set as a sorted array of strings — the wire form a server hands a browser so a
   * session payload can hydrate one directly. `JSON.stringify(set)` picks this up automatically.
   */
  toJSON(): Permission[] {
    return this.values();
  }

  /**
   * Deliberately a summary rather than a listing. A set can hold hundreds of permissions and this
   * type ends up attached to logs and spans; dumping the whole policy into telemetry on every
   * request would be both noisy and a disclosure.
   */
  toString(): string {
    return `PermissionSet(n=${String(this.size)})`;
  }
}

/** A set that grants nothing. Shared singleton — every empty set behaves identically. */
export const emptyPermissionSet = new PermissionSet();

/** Builds a {@link PermissionSet} from a variadic list, for call sites that read better that way. */
export function newPermissionSet(...perms: readonly Permission[]): PermissionSet {
  return new PermissionSet(perms);
}

/**
 * Rebuilds a {@link PermissionSet} from a decoded session payload — the browser half of the seam
 * that {@link PermissionSet.toJSON} opens on the server.
 *
 * It is deliberately tolerant: anything that is not an array of strings hydrates to the empty set
 * rather than throwing. A malformed payload should cost its holder authority, not the ability to
 * render the page — and the alternative, throwing inside a React render, fails open in the sense
 * that matters least and hardest.
 */
export function permissionSetFromJSON(value: unknown): PermissionSet {
  if (!Array.isArray(value)) {
    return emptyPermissionSet;
  }
  return new PermissionSet(value.filter((v): v is string => typeof v === "string"));
}
