import { QRCodesConfigSchema, type QRCodesConfigInput } from "./config.js";
import { newQRCodeGenerator, type QRCodeGenerator } from "./qrcodes.js";

export * from "./config.js";
export * from "./qrcodes.js";

/** Validates config (applying defaults) and returns a configured {@link QRCodeGenerator}. */
export function provideQRCodes(config?: QRCodesConfigInput): QRCodeGenerator {
  return newQRCodeGenerator(QRCodesConfigSchema.parse(config ?? {}));
}
