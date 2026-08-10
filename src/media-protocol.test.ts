import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import {
  AgentDriverApiError,
  AgentDriverApiClient,
  parseAgentMediaExecutionResult,
  parseAgentMediaSchemaBinding,
  parseAgentMediaToolFailure,
} from "./driver-api-client.js";
import {
  classifyMediaExecutionResult,
  verifiedRejectedToolResponse,
} from "./driver-runtime.js";
import { validateDynamicToolArguments } from "./dynamic-tool-validation.js";
import {
  admitCreativeMedia,
  createAgentImageMediaContract,
  PortableMediaInspector,
} from "./media-inspector.js";
import type { AgentCredentialStore } from "./credential-store.js";
import { applyAgentDriverBoundArguments } from "./protocol.js";

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

describe("typed media tool failures", () => {
  const failure = {
    schemaVersion: "starlight.agent-media-tool-failure.v1" as const,
    code: "provider-schema-invalid" as const,
    phase: "provider-schema" as const,
    message: "The provider input does not match the selected live schema.",
    field: "variants[0].providerInput.aspect_ratio",
    accepted: false as const,
    operationCreated: false as const,
    providerDispatchStarted: false as const,
    mechanicallyRetryable: true,
    requiresUserClarification: false,
    mustStop: false,
    schemaRefreshAllowed: false,
    nextEventSequence: 8,
  };

  function apiReturning(response: Response) {
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
    return new AgentDriverApiClient({
      store,
      fetch: vi.fn(async () => response) as typeof fetch,
      now: () => 10_000,
    });
  }

  it("preserves the server phase, exact field, and retry contract", () => {
    expect(parseAgentMediaToolFailure(failure)).toEqual(failure);
  });

  it("surfaces the typed server failure without reclassifying it", async () => {
    const request = apiReturning(Response.json(failure, { status: 422 }));

    const error = await request
      .proposeMediaExecution({
        leaseId: "lease_test",
        fencingToken: 1,
        expectedSequence: 7,
        callId: "call_test",
        arguments: {},
        sourceRuntimeVersion: "codex-test",
        driverRuntimeVersion: "driver-test",
      })
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(AgentDriverApiError);
    expect(error).toMatchObject({
      code: "media-tool-failure",
      status: 422,
      nextEventSequence: 8,
      mediaFailure: failure,
    });
  });

  it("does not disguise an unknown platform response as bad arguments", async () => {
    const request = apiReturning(
      Response.json({ error: "internal" }, { status: 500 }),
    );

    const error = await request
      .proposeMediaExecution({
        leaseId: "lease_test",
        fencingToken: 1,
        expectedSequence: 7,
        callId: "call_test",
        arguments: {},
        sourceRuntimeVersion: "codex-test",
        driverRuntimeVersion: "driver-test",
      })
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(AgentDriverApiError);
    expect(error).toMatchObject({ code: "platform-failure", status: 500 });
  });
});

describe("exact media schema bindings", () => {
  const fingerprint = `sha256:${"b".repeat(64)}`;
  const binding = {
    schemaVersion: "starlight.media-schema-binding.v1" as const,
    bindingId: "binding_00000000-0000-4000-8000-000000000001",
    kind: "video" as const,
    endpoints: [
      {
        endpointId: "minimax/h3/image-to-video",
        schemaFingerprint: fingerprint,
      },
    ],
    toolDefinition: {
      schemaVersion: "starlight.media-schema-binding.v1",
      name: "starlight_propose_video" as const,
      capability: "text" as const,
      description: "Submit the exact bound video proposal.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["schemaVersion", "outputCount", "variants"],
        properties: {
          schemaVersion: {
            type: "string",
            const: "starlight.media-execution-intent.v2",
          },
          outputCount: { type: "integer", minimum: 1, maximum: 16 },
          variants: {
            type: "array",
            minItems: 1,
            maxItems: 16,
            items: {
              oneOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "endpointId",
                    "schemaFingerprint",
                    "providerInput",
                    "requestedModel",
                    "selectionReason",
                  ],
                  properties: {
                    endpointId: {
                      type: "string",
                      const: "minimax/h3/image-to-video",
                    },
                    schemaFingerprint: {
                      type: "string",
                      const: fingerprint,
                    },
                    providerInput: {
                      type: "object",
                      additionalProperties: false,
                      required: ["prompt", "image_url", "duration"],
                      $defs: { duration: { type: "integer", enum: [5, 10] } },
                      properties: {
                        prompt: { type: "string" },
                        image_url: { type: "string" },
                        duration: { type: "integer", enum: [5, 10] },
                      },
                    },
                    requestedModel: { type: "string" },
                    selectionReason: { type: "string" },
                  },
                },
              ],
            },
          },
        },
      },
      boundArguments: {
        kind: "video",
        schemaBindingId: "binding_00000000-0000-4000-8000-000000000001",
      },
    },
    continuationInstructions: "Use the exact bound proposal once.",
    expiresAt: 20_000,
    nextEventSequence: 8,
    operationCreated: false as const,
    providerDispatchStarted: false as const,
  };

  it("parses and enforces the exact server-supplied provider grammar", () => {
    const parsed = parseAgentMediaSchemaBinding(binding);
    const validArguments = {
      schemaVersion: "starlight.media-execution-intent.v2",
      outputCount: 1,
      variants: [
        {
          endpointId: "minimax/h3/image-to-video",
          schemaFingerprint: fingerprint,
          providerInput: {
            prompt: "A deliberate move.",
            image_url: "starlight://artifact/artifact_portrait",
            duration: 5,
          },
          requestedModel: "MiniMax H3",
          selectionReason: "The exact live schema matches the request.",
        },
      ],
    };

    expect(
      validateDynamicToolArguments(parsed.toolDefinition, validArguments),
    ).toMatchObject({ valid: true });
    expect(
      validateDynamicToolArguments(parsed.toolDefinition, {
        ...validArguments,
        variants: [
          {
            ...validArguments.variants[0],
            providerInput: {
              prompt: "A deliberate move.",
              image_url: "starlight://artifact/artifact_portrait",
            },
          },
        ],
      }),
    ).toMatchObject({
      valid: false,
      failure: { field: "variants.0.providerInput.duration" },
    });
    expect(
      applyAgentDriverBoundArguments(parsed.toolDefinition, validArguments),
    ).toMatchObject({
      kind: "video",
      schemaBindingId: binding.bindingId,
    });
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
