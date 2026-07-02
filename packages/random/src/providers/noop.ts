import type { RandomGenerator } from "../random.js";

/**
 * A {@link RandomGenerator} that returns empty values for every call. The port of
 * platform-go's `noop` generator — for tests and wiring where randomness is irrelevant.
 */
export class NoopGenerator implements RandomGenerator {
  generateRawBytes(): Uint8Array {
    return new Uint8Array();
  }

  generateHexEncodedString(): string {
    return "";
  }

  generateBase32EncodedString(): string {
    return "";
  }

  generateBase64EncodedString(): string {
    return "";
  }
}
