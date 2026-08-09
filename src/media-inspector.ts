import { createHash } from "node:crypto";

import sharp from "sharp";

type ImageMediaType = "image/png" | "image/jpeg" | "image/webp";

interface ImageProbe {
  readonly container: string;
  readonly streams: readonly {
    readonly type: "video";
    readonly codec: string;
    readonly width: number;
    readonly height: number;
  }[];
}

function format(mediaType: ImageMediaType, detected: string | undefined) {
  const expected =
    mediaType === "image/png"
      ? "png"
      : mediaType === "image/jpeg"
        ? "jpeg"
        : "webp";
  if (detected !== expected) {
    throw new Error("Image bytes do not match the declared media type.");
  }
  return expected;
}

export class PortableMediaInspector {
  async inspect(input: {
    readonly bytes: Uint8Array;
    readonly declaredMediaType: string;
  }) {
    if (
      input.declaredMediaType !== "image/png" &&
      input.declaredMediaType !== "image/jpeg" &&
      input.declaredMediaType !== "image/webp"
    ) {
      throw new Error("The image media type is unsupported.");
    }
    const pipeline = sharp(input.bytes, {
      failOn: "error",
      limitInputPixels: 40_000_000,
    });
    const metadata = await pipeline.metadata();
    const width = metadata.width;
    const height = metadata.height;
    if (
      width === undefined ||
      height === undefined ||
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1
    ) {
      throw new Error("Image dimensions are invalid.");
    }
    const codec = format(input.declaredMediaType, metadata.format);
    await pipeline.clone().raw().toBuffer();
    return {
      container: codec,
      streams: [{ type: "video" as const, codec, width, height }],
    } satisfies ImageProbe;
  }
}

export function createAgentImageMediaContract(mediaType: ImageMediaType) {
  return Object.freeze({ kind: "image" as const, mediaType });
}

export async function admitCreativeMedia(input: {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly declaredMediaType: ImageMediaType;
  readonly contract: {
    readonly kind: "image";
    readonly mediaType: ImageMediaType;
  };
  readonly inspector: PortableMediaInspector;
}) {
  try {
    const probe = await input.inspector.inspect(input);
    return {
      status: "admitted" as const,
      probe,
      byteCount: input.bytes.byteLength,
      contentHash: createHash("sha256").update(input.bytes).digest("hex"),
      evidence: { violations: [] as const },
    };
  } catch (error) {
    return {
      status: "rejected" as const,
      probe: null,
      byteCount: input.bytes.byteLength,
      contentHash: createHash("sha256").update(input.bytes).digest("hex"),
      evidence: {
        violations: [
          {
            message:
              error instanceof Error
                ? error.message
                : "Image validation failed.",
          },
        ],
      },
    };
  }
}

export async function verifyPortableMediaInspectorRuntime() {
  if (process.platform !== "darwin") {
    throw new Error(
      "The Starlight local driver currently supports macOS only.",
    );
  }
  const fixture = await sharp({
    create: {
      width: 1,
      height: 1,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .png()
    .toBuffer();
  await new PortableMediaInspector().inspect({
    bytes: fixture,
    declaredMediaType: "image/png",
  });
  return { ready: true as const, implementation: "sharp" as const };
}
