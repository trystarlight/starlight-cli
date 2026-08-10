import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  parseAgentMediaExecutionResult,
  parseAgentMediaSchemaBinding,
  parseAgentMediaSchemaNavigationResult,
  parseAgentMediaToolFailure,
} from "./driver-api-client.js";
import { validateDynamicToolArguments } from "./dynamic-tool-validation.js";
import {
  applyLegacyAgentMediaProposalCompatibility,
  type AgentDriverToolDefinition,
} from "./protocol.js";

const FIXTURE_SHA256 =
  "3fdf23d7d35aec9986567f93f47093c744d2d9e977b137111a84818d1de045dd";

type JsonRecord = Readonly<Record<string, unknown>>;

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as JsonRecord;
}

async function fixture() {
  const source = await readFile(
    new URL(
      "../fixtures/media-proposal-compatibility.v1.json",
      import.meta.url,
    ),
    "utf8",
  );
  return {
    source,
    value: record(JSON.parse(source) as unknown, "Media compatibility fixture"),
  };
}

function stableProposalDefinition(): AgentDriverToolDefinition {
  return {
    schemaVersion: "starlight.media-execution-intent.v2",
    name: "starlight_propose_media_execution",
    capability: "text",
    description: "Fixture-only stable media proposal contract.",
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
        idempotencyKey: { type: "string", minLength: 1, maxLength: 200 },
        kind: { type: "string", const: "video" },
        schemaBindingId: {
          type: "string",
          pattern: "^binding_[0-9a-f-]{36}$",
        },
        subject: { type: "object" },
        references: { type: "object" },
        derivation: { type: "object" },
        outputCount: { type: "integer", minimum: 1, maximum: 16 },
        variants: {
          type: "array",
          minItems: 1,
          maxItems: 16,
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
              endpointId: { type: "string" },
              schemaFingerprint: {
                type: "string",
                pattern: "^sha256:[a-f0-9]{64}$",
              },
              providerInput: { type: "object" },
              requestedModel: { type: "string" },
              selectionReason: { type: "string" },
            },
          },
        },
      },
    },
  };
}

describe("public media proposal compatibility fixture", () => {
  it("matches the platform fixture byte-for-byte and round-trips as JSON", async () => {
    const { source, value } = await fixture();
    expect(createHash("sha256").update(source).digest("hex")).toBe(
      FIXTURE_SHA256,
    );
    expect(value["schemaVersion"]).toBe(
      "starlight.media-proposal-compatibility-fixture.v1",
    );
    expect(JSON.parse(JSON.stringify(value)) as unknown).toEqual(
      JSON.parse(source) as unknown,
    );
  });

  it("parses bounded navigation and the compact binding v2 contract", async () => {
    const { value } = await fixture();
    expect(
      parseAgentMediaSchemaNavigationResult(value["schemaNavigationRoot"]),
    ).toMatchObject({
      disposition: "node",
      valueComplete: false,
      pointer: "",
      operationCreated: false,
      providerDispatchStarted: false,
    });
    expect(
      parseAgentMediaSchemaNavigationResult(value["schemaNavigationProperty"]),
    ).toMatchObject({
      disposition: "node",
      pointer: "/properties/duration",
      valueComplete: true,
      value: { type: "integer", enum: [5, 10] },
    });

    const binding = parseAgentMediaSchemaBinding(value["schemaBinding"]);
    expect(binding).toMatchObject({
      schemaVersion: "starlight.media-schema-binding.v2",
      proposalContract: {
        schemaVersion: "starlight.media-execution-intent.v2",
        toolName: "starlight_propose_media_execution",
      },
    });
    expect(binding).not.toHaveProperty("toolDefinition");
    expect(binding).not.toHaveProperty("continuationInstructions");
    expect(JSON.stringify(binding)).not.toContain("providerInput");
  });

  it("requires idempotency on the stable same-turn proposal contract", async () => {
    const { value } = await fixture();
    const proposal = record(
      value["validMultiOutputProposal"],
      "Valid multi-output proposal",
    );
    const definition = stableProposalDefinition();
    expect(validateDynamicToolArguments(definition, proposal)).toMatchObject({
      valid: true,
    });
    const withoutIdempotency = { ...proposal };
    delete (withoutIdempotency as Record<string, unknown>)["idempotencyKey"];
    expect(
      validateDynamicToolArguments(definition, withoutIdempotency),
    ).toMatchObject({
      valid: false,
      failure: { field: "idempotencyKey" },
    });
  });

  it("derives legacy specialized idempotency only from authenticated call identity", () => {
    const definition: AgentDriverToolDefinition = {
      schemaVersion: "starlight.media-execution-intent.v2",
      name: "starlight_propose_video",
      capability: "text",
      description: "Legacy compatibility definition.",
      inputSchema: { type: "object" },
      boundArguments: { kind: "video" },
    };
    expect(
      applyLegacyAgentMediaProposalCompatibility(
        definition,
        "starlight_propose_video",
        { outputCount: 1 },
        "call_authenticated_001",
      ),
    ).toMatchObject({
      idempotencyKey: "call_authenticated_001",
      kind: "video",
      outputCount: 1,
    });
    expect(
      applyLegacyAgentMediaProposalCompatibility(
        definition,
        "starlight_propose_video",
        { idempotencyKey: "existing_exact_intent" },
        "call_authenticated_002",
      ),
    ).toMatchObject({ idempotencyKey: "existing_exact_intent" });
  });

  it("keeps invalid, stale, internal, and accepted outcomes distinct", async () => {
    const { value } = await fixture();
    expect(
      parseAgentMediaToolFailure(value["invalidFieldExample"]),
    ).toMatchObject({
      phase: "provider-schema",
      field: "arguments.variants.0.providerInput.duration",
      mechanicallyRetryable: true,
      mustStop: false,
    });
    expect(
      parseAgentMediaToolFailure(value["staleSchemaExample"]),
    ).toMatchObject({
      phase: "schema-stale",
      schemaRefreshAllowed: true,
      mustStop: false,
    });
    expect(
      parseAgentMediaToolFailure(value["internalFailureExample"]),
    ).toMatchObject({
      phase: "platform-internal",
      mechanicallyRetryable: false,
      mustStop: true,
    });
    expect(
      parseAgentMediaExecutionResult(value["acceptedResult"]),
    ).toMatchObject({
      disposition: "accepted",
      requestedOutputCount: 2,
      expectedOperationCount: 2,
      operations: [{ ordinal: 1 }, { ordinal: 2 }],
    });
  });
});
