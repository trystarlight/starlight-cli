import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import {
  AgentDriverApiClient,
  parseAgentMediaExecutionResult,
} from "./driver-api-client.js";
import {
  classifyMediaExecutionResult,
  verifiedRejectedToolResponse,
} from "./driver-runtime.js";
import {
  admitCreativeMedia,
  createAgentImageMediaContract,
  PortableMediaInspector,
} from "./media-inspector.js";
import type { AgentCredentialStore } from "./credential-store.js";

describe("durable media result compatibility", () => {
  it("preserves exactly three durable voice-audition receipts", () => {
    const result = parseAgentMediaExecutionResult({
      schemaVersion: "starlight.media-execution-result.v1",
      disposition: "accepted",
      proposalId: "proposal_voice_auditions",
      requestedOutputCount: 3,
      expectedOperationCount: 3,
      operations: [1, 2, 3].map((ordinal) => ({
        operationId: `voice_operation_${String(ordinal)}`,
        actionId: `voice_action_${String(ordinal)}`,
        ordinal,
        status: "planned",
      })),
      nextEventSequence: 6,
      replayed: false,
    });

    expect(result).toMatchObject({
      disposition: "accepted",
      requestedOutputCount: 3,
      expectedOperationCount: 3,
      operations: [{ ordinal: 1 }, { ordinal: 2 }, { ordinal: 3 }],
    });
  });

  it("preserves multi-output identities and partial terminal state", () => {
    expect(
      parseAgentMediaExecutionResult({
        schemaVersion: "starlight.media-execution-result.v1",
        disposition: "accepted",
        proposalId: "proposal_video_batch",
        requestedOutputCount: 3,
        expectedOperationCount: 3,
        operations: [
          {
            operationId: "operation_1",
            actionId: "action_1",
            ordinal: 1,
            status: "succeeded",
          },
          {
            operationId: "operation_2",
            actionId: "action_2",
            ordinal: 2,
            status: "failed",
          },
          {
            operationId: "operation_3",
            actionId: "action_3",
            ordinal: 3,
            status: "planned",
          },
        ],
        nextEventSequence: 9,
        replayed: false,
      }),
    ).toMatchObject({
      disposition: "accepted",
      operations: [
        { ordinal: 1, status: "succeeded" },
        { ordinal: 2, status: "failed" },
        { ordinal: 3, status: "planned" },
      ],
    });
  });

  it("rejects an accepted receipt with zero or mismatched operations", () => {
    expect(() =>
      parseAgentMediaExecutionResult({
        schemaVersion: "starlight.media-execution-result.v1",
        disposition: "accepted",
        proposalId: "proposal_empty",
        requestedOutputCount: 1,
        expectedOperationCount: 1,
        operations: [],
        nextEventSequence: 3,
        replayed: false,
      }),
    ).toThrow(/operation count/u);
  });

  it("preserves typed catalogue alternatives and zero-operation adjustments", () => {
    const result = parseAgentMediaExecutionResult({
      schemaVersion: "starlight.media-execution-result.v1",
      disposition: "clarification-required",
      proposalId: "proposal_framing",
      code: "model-adjustment-required",
      message:
        "The selected route controls framing and cannot accept explicit 9:16.",
      candidates: [],
      modelAlternatives: [
        {
          model: "Compatible Portrait Video",
          reason: "Supports explicit portrait framing for this input mode.",
        },
      ],
      adjustments: [
        {
          field: "framing",
          requested: "9:16",
          proposed: "auto",
          reason: "The selected route infers framing from its source image.",
        },
      ],
      nextEventSequence: 5,
      replayed: false,
    });

    expect(result).toMatchObject({
      disposition: "clarification-required",
      modelAlternatives: [{ model: "Compatible Portrait Video" }],
      adjustments: [{ field: "framing", requested: "9:16", proposed: "auto" }],
    });
    expect(classifyMediaExecutionResult(result)).toEqual({
      toolSucceeded: true,
      durableWorkCreated: false,
      rejection:
        "The selected route controls framing and cannot accept explicit 9:16.",
    });
    expect(
      verifiedRejectedToolResponse(
        "The video is queued.",
        result.disposition === "clarification-required" ? result.message : "",
      ),
    ).toContain("No operation was created and no provider work started.");
  });

  it("accepts an exact eight-output system-image batch and rejects count drift", () => {
    const variants = Array.from({ length: 8 }, (_, index) => ({
      ordinal: index + 1,
      prompt: `Image direction ${String(index + 1)}`,
    }));
    const fixture = {
      schemaVersion: "starlight.media-execution-result.v1",
      disposition: "driver-execution-required",
      kind: "system-image",
      proposalId: "proposal_image_batch",
      requestedOutputCount: 8,
      expectedOperationCount: 1,
      variants,
      references: [],
      nextEventSequence: 4,
      replayed: false,
    } as const;

    expect(parseAgentMediaExecutionResult(fixture)).toMatchObject({
      requestedOutputCount: 8,
      variants,
    });
    expect(() =>
      parseAgentMediaExecutionResult({
        ...fixture,
        requestedOutputCount: 7,
      }),
    ).toThrow(/cardinality/u);
  });
});

describe("generated image upload identity", () => {
  it("carries the admitted prefixed digest through prepare and upload", async () => {
    const bytes = await sharp({
      create: {
        width: 3,
        height: 5,
        channels: 4,
        background: { r: 10, g: 20, b: 30, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const admission = await admitCreativeMedia({
      bytes,
      fileName: "generated.png",
      declaredMediaType: "image/png",
      contract: createAgentImageMediaContract("image/png"),
      inspector: new PortableMediaInspector(),
    });
    if (admission.status !== "admitted")
      throw new Error("Expected admitted image");

    const state = {
      schemaVersion: "starlight.agent-credential-store.v1" as const,
      apiUrl: "https://api.example.test",
      webUrl: "https://app.example.test",
      credential: {
        credentialId: "credential_test",
        token: "credential_token_test",
        expiresAt: 20_000,
        scopes: ["session:read", "turn:claim"] as const,
        resource: "https://app.example.test/mcp",
      },
    };
    const store: AgentCredentialStore = {
      read: async () => state,
      write: async () => undefined,
      clear: async () => undefined,
    };
    const requests: { readonly url: string; readonly init?: RequestInit }[] =
      [];
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, ...(init === undefined ? {} : { init }) });
        if (url.endsWith("/agent/v1/turns/image/prepare-upload")) {
          return Response.json({
            schemaVersion: "starlight.agent-image-upload.v1",
            status: "captured",
            replayed: false,
            uploadUrl: "https://upload.example.test/image",
          });
        }
        if (url === "https://upload.example.test/image") {
          return Response.json({ storageId: "storage_image_test" });
        }
        return new Response(null, { status: 404 });
      },
    );
    const api = new AgentDriverApiClient({
      store,
      fetch: fetcher as typeof fetch,
      now: () => 10_000,
    });

    const prepared = await api.prepareImageUpload({
      leaseId: "lease_test",
      fencingToken: 1,
      operationId: "operation_image_test",
      contentHash: admission.contentHash,
      mimeType: "image/png",
      byteLength: admission.byteCount,
      width: 3,
      height: 5,
      sourceItemId: "item_image_test",
    });
    await expect(
      api.uploadImage({
        uploadUrl: prepared.uploadUrl,
        bytes,
        mimeType: "image/png",
      }),
    ).resolves.toEqual({ storageId: "storage_image_test" });

    expect(admission.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
      contentHash: admission.contentHash,
      byteLength: bytes.byteLength,
      width: 3,
      height: 5,
    });
    expect(requests[1]?.init).toMatchObject({
      method: "POST",
      headers: { "content-type": "image/png" },
    });
  });
});
