/**
 * A fixed-capacity FIFO queue — the analogue of the Go recorder's buffered channel, and the
 * reason `record()` can be O(1) and allocation-free on the hot path.
 *
 * `push` reports fullness rather than growing: an unbounded queue in front of a slow sink
 * trades a dropped-event counter for an out-of-memory kill, which is the strictly worse
 * failure. A plain array with `shift()` would be O(n) per drained event once the queue is
 * deep, exactly when the pipeline is already behind.
 */
export class RingBuffer<T> {
  readonly #items: (T | undefined)[];
  #head = 0;
  #count = 0;

  /** @param capacity Maximum live items. Non-positive capacities are clamped to zero (always full). */
  constructor(capacity: number) {
    this.#items = new Array<T | undefined>(Math.max(0, Math.trunc(capacity)));
  }

  /** Maximum live items. */
  get capacity(): number {
    return this.#items.length;
  }

  /** Live item count. */
  get size(): number {
    return this.#count;
  }

  /** Appends `item`, returning `false` (without storing it) when the buffer is full. */
  push(item: T): boolean {
    if (this.#count >= this.#items.length) {
      return false;
    }
    this.#items[(this.#head + this.#count) % this.#items.length] = item;
    this.#count++;
    return true;
  }

  /**
   * Removes and returns the oldest item, or `undefined` when empty. `T` may itself include
   * `undefined`, so callers that need to distinguish must guard on {@link size} first.
   */
  shift(): T | undefined {
    if (this.#count === 0) {
      return undefined;
    }
    const item = this.#items[this.#head];
    // Released rather than left behind: a stale slot would pin the event (and everything it
    // references) alive for as long as the recorder lives.
    this.#items[this.#head] = undefined;
    this.#head = (this.#head + 1) % this.#items.length;
    this.#count--;
    return item;
  }
}
