import { describe, expect, it, vi } from "vitest";

import type { CodexTextInput } from "./codex-app-server-client.js";
import type {
  AgentDriverApiClient,
  AgentDriverClaim,
} from "./driver-api-client.js";
import { AgentDriverRuntime } from "./driver-runtime.js";
import type { AgentDriverToolDefinition } from "./protocol.js";

const routing = {
  policyVersion: "starlight.agent-routing.v1" as const,
  executionProfile: "auto" as const,
  reasoningDepth: "adapter-default" as const,
  minimumCapability: "text" as const,
  requiredInputCapabilities: [],
  reason: "automatic-capable-conversation" as const,
};

const workingSet = {
  schemaVersion: "starlight.agent-working-set.v1",
  subject: { kind: "unsaved" as const, binding: null },
  budget: { availability: "unavailable" as const },
  operations: [],
  fencing: { turnVersion: 1, turnEventSequence: 2 },
};

const bindingTool: AgentDriverToolDefinition = {
  schemaVersion: "starlight.media-schema-binding-request.v1",
  name: "starlight_prepare_media_schema_binding",
  capability: "text",
  description: "Bind exact live endpoint schemas.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "kind", "endpoints"],
    properties: {
      schemaVersion: {
        type: "string",
        const: "starlight.media-schema-binding-request.v1",
      },
      kind: { type: "string", const: "video" },
      endpoints: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["endpointId", "schemaFingerprint"],
          properties: {
            endpointId: { type: "string" },
            schemaFingerprint: { type: "string" },
          },
        },
      },
    },
  },
};

const schemaTool: AgentDriverToolDefinition = {
  schemaVersion: "starlight.agent-media-discovery.v1",
  name: "starlight_get_media_model_schema",
  capability: "text",
  description: "Get the exact live endpoint schema.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["endpointId"],
    properties: { endpointId: { type: "string" } },
  },
};

describe("media schema binding continuation", () => {
  it("uses one internal continuation with the exact server tool and no second Starlight turn", async () => {
    const controller = new AbortController();
    const fingerprint = `sha256:${"c".repeat(64)}`;
    const bindingId = "binding_00000000-0000-4000-8000-000000000002";
    const exactProposalTool: AgentDriverToolDefinition = {
      schemaVersion: "starlight.media-schema-binding.v1",
      name: "starlight_propose_video",
      capability: "text",
      description: "Submit one exact bound proposal.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["schemaVersion", "outputCount", "variants"],
        properties: {
          schemaVersion: {
            type: "string",
            const: "starlight.media-execution-intent.v2",
          },
          outputCount: { type: "integer", const: 1 },
          variants: {
            type: "array",
            minItems: 1,
            maxItems: 1,
            items: {
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
                schemaFingerprint: { type: "string", const: fingerprint },
                providerInput: {
                  type: "object",
                  additionalProperties: false,
                  required: ["prompt", "image_url"],
                  properties: {
                    prompt: { type: "string" },
                    image_url: { type: "string" },
                  },
                },
                requestedModel: { type: "string" },
                selectionReason: { type: "string" },
              },
            },
          },
        },
      },
      boundArguments: { kind: "video", schemaBindingId: bindingId },
    };
    const claim: AgentDriverClaim = {
      turn: {
        workspaceId: "workspace_test",
        sessionId: "session_test",
        sessionTitle: "Media session",
        turnId: "turn_test",
        capability: "text",
        routing,
        behaviorProfileVersion: "starlight.creative-driver-behavior-profile.v2",
        requiredInputCapabilities: [],
        userMessage: {
          messageId: "message_test",
          sequence: 1,
          role: "user",
          parts: [{ type: "text", text: "Create one exact H3 video." }],
          text: "Create one exact H3 video.",
          createdAt: 1,
        },
        queuedAt: 1,
        recoveryCount: 0,
        workingSet,
      },
      lease: {
        leaseId: "lease_00000000-0000-4000-8000-000000000003",
        fencingToken: 1,
        expiresAt: 100_000,
      },
      nextEventSequence: 2,
      replayed: false,
    };
    let pendingReturned = false;
    const proposeMediaExecution = vi.fn(
      async (input: { arguments: unknown }) => {
        expect(input.arguments).toMatchObject({
          kind: "video",
          schemaBindingId: bindingId,
        });
        return {
          schemaVersion: "starlight.media-execution-result.v1" as const,
          disposition: "accepted" as const,
          proposalId: "proposal_test",
          requestedOutputCount: 1,
          expectedOperationCount: 1,
          operations: [
            {
              operationId: "operation_test",
              actionId: "action_test",
              ordinal: 1,
              status: "planned",
            },
          ],
          nextEventSequence: 4,
          replayed: false,
        };
      },
    );
    const completeTurn = vi.fn(async () => {
      controller.abort();
      return {};
    });
    const api = {
      getCredentialContext: async () => ({
        credentialId: "credential_test",
        resource: "https://app.example.test/mcp",
        workspace: { workspaceId: "workspace_test", name: "Workspace" },
      }),
      heartbeatPresence: async () => ({}),
      reportOffline: async () => ({}),
      listPending: async () => {
        if (pendingReturned) return [];
        pendingReturned = true;
        return [claim.turn];
      },
      claimTurn: async () => claim,
      appendProgress: async () => ({ nextEventSequence: 3 }),
      heartbeatTurn: async () => ({}),
      listAcceptedInterventions: async () => [],
      getSessionContext: async () => ({
        behaviorProfileVersion:
          "starlight.creative-driver-behavior-profile.v2" as const,
        driverProtocolVersion: "1.0.0" as const,
        driverInstructions: {
          schemaVersion: "starlight.agent-driver-instructions.v1" as const,
          text: "Use only authenticated Starlight tools.",
          tools: [schemaTool, bindingTool],
        },
        workingSet,
        session: { sessionId: "session_test", title: "Media session" },
        messages: [claim.turn.userMessage],
        activeTurn: {
          turnId: "turn_test",
          status: "running",
          eventSequence: 2,
          capability: "text" as const,
          routing,
          requiredInputCapabilities: [],
        },
      }),
      prepareMediaSchemaBinding: async () => ({
        schemaVersion: "starlight.media-schema-binding.v1" as const,
        bindingId,
        kind: "video" as const,
        endpoints: [
          {
            endpointId: "minimax/h3/image-to-video",
            schemaFingerprint: fingerprint,
          },
        ],
        toolDefinition: exactProposalTool,
        continuationInstructions: "Use the exact bound proposal once.",
        expiresAt: 50_000,
        nextEventSequence: 3,
        operationCreated: false as const,
        providerDispatchStarted: false as const,
      }),
      getMediaModelSchema: async () => ({
        schemaVersion: "starlight.fal-live-schema.v1",
        endpointId: "minimax/h3/image-to-video",
        schemaFingerprint: fingerprint,
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["prompt", "image_url"],
          properties: {
            prompt: { type: "string" },
            image_url: { type: "string" },
          },
        },
        openApi: {
          paths: {
            "/fal-ai/minimax-h3/image-to-video": {
              post: { requestBody: { $ref: "#/components/H3Request" } },
            },
          },
        },
      }),
      proposeMediaExecution,
      completeTurn,
      relinquishTurn: async () => {
        controller.abort();
        return {};
      },
      failTurn: async () => {
        controller.abort();
        return {};
      },
    } as unknown as AgentDriverApiClient;
    const generateInputs: CodexTextInput[] = [];
    const codex = {
      accountStatus: async () => ({ type: "chatgpt", planType: "plus" }),
      executionProfileStatus: async () => ({
        modelId: "gpt-test",
        supportedProfiles: ["auto"],
      }),
      imageCapabilityStatus: async () => ({
        available: false,
        reason: "runtime-capability-unavailable",
        skillPath: null,
        codexRuntimeVersion: "codex-test",
      }),
      imageInputCapabilityStatus: async () => ({
        available: false,
        reason: "default-model-does-not-support-image-input",
        modelId: "gpt-test",
      }),
      installationStatus: () => ({ installedVersion: "codex-test" }),
      steer: async () => ({ status: "not-active", turnId: null }),
      stop: vi.fn(async () => undefined),
      generateText: async (input: CodexTextInput) => {
        generateInputs.push(input);
        const callback = input.callbacks?.onDynamicToolCall;
        if (callback === undefined) throw new Error("Tool callback is missing");
        if (generateInputs.length === 1) {
          const schema = await callback({
            toolName: "starlight_get_media_model_schema",
            callId: "call_schema",
            arguments: { endpointId: "minimax/h3/image-to-video" },
            threadId: "thread_test",
            turnId: "codex_turn_a",
          });
          expect(schema).toMatchObject({ success: true });
          expect(schema.text).toContain('"$ref"');
          const prepared = await callback({
            toolName: "starlight_prepare_media_schema_binding",
            callId: "call_bind",
            arguments: {
              schemaVersion: "starlight.media-schema-binding-request.v1",
              kind: "video",
              endpoints: [
                {
                  endpointId: "minimax/h3/image-to-video",
                  schemaFingerprint: fingerprint,
                },
              ],
            },
            threadId: "thread_test",
            turnId: "codex_turn_a",
          });
          expect(prepared).toMatchObject({ success: true });
          return "Prepared exact schema binding.";
        }
        const proposed = await callback({
          toolName: "starlight_propose_video",
          callId: "call_propose",
          arguments: {
            schemaVersion: "starlight.media-execution-intent.v2",
            outputCount: 1,
            variants: [
              {
                endpointId: "minimax/h3/image-to-video",
                schemaFingerprint: fingerprint,
                providerInput: {
                  prompt: "A deliberate move.",
                  image_url: "starlight://artifact/artifact_portrait",
                },
                requestedModel: "MiniMax H3",
                selectionReason: "The exact live schema matches.",
              },
            ],
          },
          threadId: "thread_test",
          turnId: "codex_turn_b",
        });
        expect(proposed).toMatchObject({ success: true });
        return "Starlight durably accepted one operation.";
      },
    };

    const runtime = new AgentDriverRuntime({
      api,
      codex: codex as never,
      sleep: async (_duration, signal) => {
        if (signal.aborted) return;
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    });
    await runtime.run(controller.signal);

    expect(generateInputs).toHaveLength(2);
    expect(generateInputs[0]?.internalContinuation).toBeUndefined();
    expect(generateInputs[1]).toMatchObject({
      internalContinuation: { bindingId },
      dynamicTools: [{ name: "starlight_propose_video" }],
    });
    expect(proposeMediaExecution).toHaveBeenCalledTimes(1);
    expect(completeTurn).toHaveBeenCalledTimes(1);
  });
});
