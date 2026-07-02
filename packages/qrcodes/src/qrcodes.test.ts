import { describe, expect, it } from "vitest";

import { provideQRCodes } from "./index.js";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const OTPAUTH_URI =
  "otpauth://totp/PrimAndProper:user@example.com?secret=JBSWY3DPEHPK3PXP&issuer=PrimAndProper";

describe("provideQRCodes", () => {
  const generator = provideQRCodes();

  it("toDataUrl returns a PNG data URL", async () => {
    const url = await generator.toDataUrl("hello");
    expect(url).toBeTypeOf("string");
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("toSvg returns an SVG document", async () => {
    const svg = await generator.toSvg("hello");
    expect(svg).toContain("<svg");
  });

  it("toBuffer returns non-empty PNG bytes", async () => {
    const buffer = await generator.toBuffer("hello");
    expect(buffer).toBeInstanceOf(Uint8Array);
    expect(buffer.length).toBeGreaterThan(0);
    expect(Array.from(buffer.subarray(0, 4))).toStrictEqual(PNG_MAGIC);
  });

  it("encodes a realistic otpauth:// TOTP URI", async () => {
    const url = await generator.toDataUrl(OTPAUTH_URI);
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("accepts custom options", async () => {
    const url = await generator.toDataUrl(OTPAUTH_URI, {
      errorCorrectionLevel: "H",
      width: 512,
    });
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
  });
});
