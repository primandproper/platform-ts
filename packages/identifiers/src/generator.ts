/** Generates and validates opaque string identifiers. The analogue of Go's `IDGenerator`. */
export interface IdentifierGenerator {
  /** Produces a fresh unique identifier. */
  generate(): string;
  /** Reports whether `id` conforms to this generator's format. */
  isValid(id: string): boolean;
}
