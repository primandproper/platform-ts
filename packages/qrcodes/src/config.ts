import { z } from "zod";

/** QR error-correction levels, low to high redundancy. Mirrors the `qrcode` library's set. */
export const QR_ERROR_CORRECTION_LEVELS = ["L", "M", "Q", "H"] as const;

/**
 * Default QR rendering options applied to every generation. Replaces the Go `env:`-tagged
 * struct; call-site options override these per call. Defaults match the `qrcode` library:
 * `M` error correction and a quiet-zone margin of 4 modules.
 */
export const QRCodesConfigSchema = z.object({
  /** Error-correction level; higher tolerates more damage at the cost of density. */
  errorCorrectionLevel: z.enum(QR_ERROR_CORRECTION_LEVELS).default("M"),
  /** Quiet-zone width around the symbol, in modules. */
  margin: z.number().int().nonnegative().default(4),
  /** Forces an output image width in pixels; ignored when too small to fit the symbol. */
  width: z.number().int().positive().optional(),
});

export type QRErrorCorrectionLevel = (typeof QR_ERROR_CORRECTION_LEVELS)[number];
export type QRCodesConfig = z.infer<typeof QRCodesConfigSchema>;
export type QRCodesConfigInput = z.input<typeof QRCodesConfigSchema>;
