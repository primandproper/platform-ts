import QRCode, { type QRCodeRenderersOptions } from "qrcode";

import type { QRCodesConfig, QRErrorCorrectionLevel } from "./config.js";
import { QRCodeError } from "./errors.js";

/**
 * Per-call rendering overrides — a curated subset of the `qrcode` library's options.
 * Anything omitted falls back to the configured {@link QRCodesConfig} defaults.
 */
export interface QRCodeOptions {
  errorCorrectionLevel?: QRErrorCorrectionLevel;
  margin?: number;
  width?: number;
}

/**
 * A thin QR-code generator over the `qrcode` library, oriented toward TOTP-setup flows
 * (encoding `otpauth://` URIs) but general-purpose. Each method takes the raw payload plus
 * optional per-call overrides layered over the configured defaults.
 */
export interface QRCodeGenerator {
  /** Encodes `data` as a PNG `data:` URL. */
  toDataUrl(data: string, opts?: QRCodeOptions): Promise<string>;
  /** Encodes `data` as an SVG document string. */
  toSvg(data: string, opts?: QRCodeOptions): Promise<string>;
  /** Encodes `data` as raw PNG bytes. */
  toBuffer(data: string, opts?: QRCodeOptions): Promise<Uint8Array>;
}

/**
 * Merges per-call overrides onto the configured defaults, building the options object
 * conditionally so an absent optional field is never passed as `undefined` (the package's
 * `exactOptionalPropertyTypes` setting forbids it).
 */
function mergeOptions(
  defaults: QRCodesConfig,
  opts?: QRCodeOptions,
): QRCodeRenderersOptions {
  const errorCorrectionLevel =
    opts?.errorCorrectionLevel ?? defaults.errorCorrectionLevel;
  const margin = opts?.margin ?? defaults.margin;
  const width = opts?.width ?? defaults.width;

  const merged: QRCodeRenderersOptions = { errorCorrectionLevel, margin };
  if (width !== undefined) {
    merged.width = width;
  }
  return merged;
}

class QRCodeGeneratorImpl implements QRCodeGenerator {
  readonly #defaults: QRCodesConfig;

  constructor(defaults: QRCodesConfig) {
    this.#defaults = defaults;
  }

  async toDataUrl(data: string, opts?: QRCodeOptions): Promise<string> {
    try {
      return await QRCode.toDataURL(data, mergeOptions(this.#defaults, opts));
    } catch (err) {
      throw new QRCodeError("data URL", err);
    }
  }

  async toSvg(data: string, opts?: QRCodeOptions): Promise<string> {
    try {
      return await QRCode.toString(data, {
        ...mergeOptions(this.#defaults, opts),
        type: "svg",
      });
    } catch (err) {
      throw new QRCodeError("SVG", err);
    }
  }

  async toBuffer(data: string, opts?: QRCodeOptions): Promise<Uint8Array> {
    try {
      return await QRCode.toBuffer(data, mergeOptions(this.#defaults, opts));
    } catch (err) {
      throw new QRCodeError("PNG buffer", err);
    }
  }
}

/** Builds a {@link QRCodeGenerator} from validated config. */
export function newQRCodeGenerator(defaults: QRCodesConfig): QRCodeGenerator {
  return new QRCodeGeneratorImpl(defaults);
}
