import { PlatformError } from "@primandproper/errors";

/**
 * Thrown when the underlying `qrcode` library fails to render (e.g. the payload exceeds the
 * capacity of the chosen error-correction level). Wraps the raw library error as its `cause`
 * so callers get a typed, contextual failure instead of an opaque vendor error.
 */
export class QRCodeError extends PlatformError {
  constructor(format: string, cause: unknown) {
    super("qrcodes/render-failed", `failed to render QR code as ${format}`, { cause });
    this.name = "QRCodeError";
  }
}
