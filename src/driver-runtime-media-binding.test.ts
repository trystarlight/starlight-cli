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

const searchTool: AgentDriverToolDefinition = {
  schemaVersion: "starlight.agent-media-discovery.v1",
  name: "starlight_search_media_models",
  capability: "text",
  description: "Search the live admitted media catalogue.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: { type: "string", minLength: 1 },
      limit: { type: "integer", minimum: 1, maximum: 32 },
    },
  },
};

describe("same-turn stable media proposal", () => {
  it("navigates, binds, and proposes through one Codex turn", async () => {
    const controller = new AbortController();
    const fingerprint = `sha256:${"c".repeat(64)}`;
    const bindingId = "binding_00000000-0000-4000-8000-000000000002";
    const stableProposalTool: AgentDriverToolDefinition = {
      schemaVersion: "starlight.media-execution-intent.v2",
      name: "starlight_propose_media_execution",
      capability: "text",
      description: "Submit one stable server-validated media proposal.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: [
          "schemaVersion",
          "idempotencyKey",
          "kind",
          "schemaBindingId",
          "subject",
          "references",
          "derivation",
          "outputCount",
          "variants",
        ],
        properties: {
          schemaVersion: {
            type: "string",
            const: "starlight.media-execution-intent.v2",
          },
          idempotencyKey: { type: "string", minLength: 1 },
          kind: { type: "string", const: "video" },
          schemaBindingId: { type: "string", const: bindingId },
          subject: { type: "object" },
          references: { type: "object" },
          derivation: { type: "object" },
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
                providerInput: { type: "object" },
                requestedModel: { type: "string" },
                selectionReason: { type: "string" },
              },
            },
          },
        },
      },
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
          idempotencyKey: "proposal:h3:one-output:001",
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
          tools: [searchTool, schemaTool, bindingTool, stableProposalTool],
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
      searchMediaModels: vi.fn(async () => ({
        schemaVersion: "starlight.agent-media-model-search.v1",
        source: "fal-model-search",
        retrievedAt: 10_000,
        query: "video",
        matchedCount: 0,
        returnedCount: 0,
        limit: 32,
        models: [],
        operationCreated: false,
        providerDispatchStarted: false,
      })),
      prepareMediaSchemaBinding: async () => ({
        schemaVersion: "starlight.media-schema-binding.v2" as const,
        bindingId,
        kind: "video" as const,
        endpoints: [
          {
            endpointId: "minimax/h3/image-to-video",
            schemaFingerprint: fingerprint,
          },
        ],
        proposalContract: {
          schemaVersion: "starlight.media-execution-intent.v2" as const,
          toolName: "starlight_propose_media_execution" as const,
        },
        expiresAt: 50_000,
        nextEventSequence: 3,
        operationCreated: false as const,
        providerDispatchStarted: false as const,
      }),
      getMediaModelSchema: async () => ({
        schemaVersion: "starlight.agent-media-schema-navigation.v1" as const,
        endpointId: "minimax/h3/image-to-video",
        schemaFingerprint: fingerprint,
        operationCreated: false as const,
        providerDispatchStarted: false as const,
        disposition: "node" as const,
        binding: {
          endpointId: "minimax/h3/image-to-video",
          schemaFingerprint: fingerprint,
        },
        documents: [
          {
            document: "input" as const,
            pointer: "" as const,
            nodeType: "object" as const,
            byteLength: 12_000,
          },
        ],
        document: "input" as const,
        pointer: "/properties/image_url",
        nodeType: "object" as const,
        byteLength: 56,
        valueComplete: true,
        value: { type: "string", format: "uri" },
        limits: {
          maximumResultBytes: 24_000,
          maximumInlineValueBytes: 8_000,
          maximumPageEntries: 32,
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
        const search = await callback({
          toolName: "starlight_search_media_models",
          callId: "call_search",
          arguments: { query: "video", limit: 32 },
          threadId: "thread_test",
          turnId: "codex_turn_a",
        });
        expect(search).toMatchObject({ success: true });
        expect(api.searchMediaModels).toHaveBeenCalledWith({
          leaseId: claim.lease.leaseId,
          fencingToken: claim.lease.fencingToken,
          query: "video",
          limit: 32,
        });
        const schema = await callback({
          toolName: "starlight_get_media_model_schema",
          callId: "call_schema",
          arguments: { endpointId: "minimax/h3/image-to-video" },
          threadId: "thread_test",
          turnId: "codex_turn_a",
        });
        expect(schema).toMatchObject({ success: true });
        expect(schema.text).toContain('"pointer":"/properties/image_url"');
        expect(schema.text).not.toContain('"inputSchema"');
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
        expect(prepared.text).toContain(
          '"toolName":"starlight_propose_media_execution"',
        );
        const proposed = await callback({
          toolName: "starlight_propose_media_execution",
          callId: "call_propose",
          arguments: {
            schemaVersion: "starlight.media-execution-intent.v2",
            idempotencyKey: "proposal:h3:one-output:001",
            kind: "video",
            schemaBindingId: bindingId,
            subject: { kind: "none" },
            references: { kind: "none" },
            derivation: { kind: "new" },
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
          turnId: "codex_turn_a",
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

    expect(generateInputs).toHaveLength(1);
    expect(generateInputs[0]?.dynamicTools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "starlight_get_media_model_schema" }),
        expect.objectContaining({ name: "starlight_search_media_models" }),
        expect.objectContaining({
          name: "starlight_prepare_media_schema_binding",
        }),
        expect.objectContaining({ name: "starlight_propose_media_execution" }),
      ]),
    );
    expect(proposeMediaExecution).toHaveBeenCalledTimes(1);
    expect(completeTurn).toHaveBeenCalledTimes(1);
  });
});
