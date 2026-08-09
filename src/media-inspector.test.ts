import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  admitCreativeMedia,
  createAgentImageMediaContract,
  PortableMediaInspector,
} from "./media-inspector.js";

describe("public image admission", () => {
  it("decodes bytes and records exact dimensions and content identity", async () => {
    const bytes = await sharp({
      create: {
        width: 7,
        height: 5,
        channels: 4,
        background: { r: 20, g: 40, b: 60, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const result = await admitCreativeMedia({
      bytes,
      fileName: "image.png",
      declaredMediaType: "image/png",
      contract: createAgentImageMediaContract("image/png"),
      inspector: new PortableMediaInspector(),
    });

    expect(result).toMatchObject({
      status: "admitted",
      byteCount: bytes.byteLength,
      probe: { streams: [{ type: "video", width: 7, height: 5 }] },
    });
    expect(result.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("rejects corrupt or falsely declared bytes", async () => {
    await expect(
      admitCreativeMedia({
        bytes: Uint8Array.from([1, 2, 3]),
        fileName: "image.png",
        declaredMediaType: "image/png",
        contract: createAgentImageMediaContract("image/png"),
        inspector: new PortableMediaInspector(),
      }),
    ).resolves.toMatchObject({ status: "rejected" });
  });
});
