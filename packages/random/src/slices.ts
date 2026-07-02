/**
 * Returns a random element from `items`, or `undefined` if it is empty. The port of
 * platform-go's `random.Element`; like it, this draws from non-cryptographic randomness
 * (`Math.random`) — it is for sampling, not for secrets. Returning `undefined` on an empty
 * input follows the package's optional-over-sentinel convention rather than Go's panic.
 */
export function randomElement<T>(items: readonly T[]): T | undefined {
  if (items.length === 0) {
    return undefined;
  }
  return items[Math.floor(Math.random() * items.length)];
}
