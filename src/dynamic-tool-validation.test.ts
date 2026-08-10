import { describe, expect, it } from "vitest";

import {
  assertSupportedDynamicToolSchema,
  validateDynamicToolArguments,
} from "./dynamic-tool-validation.js";
import {
  isAgentDriverToolName,
  type AgentDriverToolDefinition,
} from "./protocol.js";

const endpointId = "fixture/video-transformation";
const schemaFingerprint = `sha256:${"d".repeat(64)}`;

const boundVideoTool = {
  schemaVersion: "starlight.media-schema-binding.v1",
  name: "starlight_propose_video",
  capability: "text",
  description: "Submit one exact server-bound video proposal.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
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
      subject: { type: "object" },
      references: { type: "object" },
      derivation: { type: "object" },
      outputCount: { type: "integer", minimum: 1, maximum: 16 },
      variants: {
        type: "array",
        minItems: 1,
        maxItems: 16,
        uniqueItems: true,
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
                endpointId: { type: "string", const: endpointId },
                schemaFingerprint: {
                  type: "string",
                  const: schemaFingerprint,
                },
                providerInput: {
                  type: "object",
                  additionalProperties: false,
                  required: ["source_url", "operation"],
                  properties: {
                    source_url: { type: "string", minLength: 1 },
                    operation: {
                      type: "string",
                      enum: ["restyle", "repair"],
                    },
                    instruction: { type: "string", minLength: 1 },
                    repair_region: {
                      type: "object",
                      additionalProperties: false,
                      required: ["x", "y", "width", "height"],
                      properties: {
                        x: { type: "number", minimum: 0, maximum: 1 },
                        y: { type: "number", minimum: 0, maximum: 1 },
                        width: { type: "number", minimum: 0, maximum: 1 },
                        height: { type: "number", minimum: 0, maximum: 1 },
                      },
                    },
                  },
                  allOf: [
                    {
                      if: {
                        required: ["operation"],
                        properties: {
                          operation: { type: "string", const: "repair" },
                        },
                      },
                      then: { required: ["repair_region"] },
                    },
                  ],
                },
                requestedModel: { type: "string", minLength: 1 },
                selectionReason: { type: "string", minLength: 1 },
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
} as const satisfies AgentDriverToolDefinition;

function proposal(providerInput: Readonly<Record<string, unknown>>) {
  return {
    schemaVersion: "starlight.media-execution-intent.v2",
    subject: { kind: "none" },
    references: { kind: "none" },
    derivation: { kind: "new" },
    outputCount: 1,
    variants: [
      {
        endpointId,
        schemaFingerprint,
        providerInput,
        requestedModel: "Selected live endpoint",
        selectionReason: "The exact retrieved schema matches this request.",
      },
    ],
  };
}

const voiceTool = {
  schemaVersion: "starlight.media-execution-intent.v2",
  name: "starlight_propose_voice_design",
  capability: "text",
  description: "Propose three comparable voice auditions.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["auditionCount", "brief", "previewText", "language"],
    properties: {
      auditionCount: { type: "integer", const: 3 },
      brief: { type: "string", minLength: 20, maxLength: 1_000 },
      previewText: { type: "string", minLength: 100, maxLength: 1_000 },
      language: {
        type: "string",
        minLength: 2,
        maxLength: 35,
        pattern: "^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$",
      },
    },
  },
} as const satisfies AgentDriverToolDefinition;

describe("server-supplied dynamic tool validation", () => {
  it("accepts the exact live provider input without interpreting its semantics", () => {
    expect(
      validateDynamicToolArguments(
        boundVideoTool,
        proposal({
          source_url: "starlight://artifact/artifact_source",
          operation: "restyle",
          instruction: "Use a restrained material treatment.",
        }),
      ),
    ).toMatchObject({ valid: true });
  });

  it("preserves nested and conditional fields from the supplied live schema", () => {
    expect(
      validateDynamicToolArguments(
        boundVideoTool,
        proposal({
          source_url: "starlight://artifact/artifact_source",
          operation: "repair",
          repair_region: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
        }),
      ),
    ).toMatchObject({ valid: true });

    expect(
      validateDynamicToolArguments(
        boundVideoTool,
        proposal({
          source_url: "starlight://artifact/artifact_source",
          operation: "repair",
        }),
      ),
    ).toMatchObject({
      valid: false,
      failure: { field: "variants.0.providerInput.repair_region" },
    });
  });

  it("returns exact actionable paths for voice cardinality and nested fields", () => {
    const common = {
      brief:
        "A warm editorial voice with restrained energy and precise diction.",
      previewText:
        "Let us compare these directions carefully, preserve the qualities that feel true, and avoid anything generic or overperformed.",
      language: "en-US",
    };
    expect(
      validateDynamicToolArguments(voiceTool, {
        auditionCount: 5,
        ...common,
      }),
    ).toMatchObject({
      valid: false,
      failure: {
        field: "auditionCount",
        message: "auditionCount must equal 3.",
      },
    });
    expect(
      validateDynamicToolArguments(voiceTool, {
        auditionCount: 3,
        ...common,
        providerModel: "hidden-route",
      }),
    ).toMatchObject({
      valid: false,
      failure: { field: "providerModel" },
    });
  });

  it("rejects oversized arguments and accepts standard schema references", () => {
    expect(
      validateDynamicToolArguments(voiceTool, {
        auditionCount: 3,
        brief: "x".repeat(33_000),
        previewText: "x".repeat(100),
        language: "en",
      }),
    ).toMatchObject({
      valid: false,
      failure: { field: "arguments" },
    });
    expect(() =>
      assertSupportedDynamicToolSchema({
        $defs: { a: { type: "object" } },
        $ref: "#/$defs/a",
      }),
    ).not.toThrow();
  });
});

describe("current media tool identities", () => {
  it.each([
    "starlight_design_character_voice",
    "starlight_create_adopted_speech",
    "starlight_create_video",
    "starlight_create_talking_avatar",
    "starlight_prepare_media_schema_binding",
    "starlight_propose_voice_design",
    "starlight_propose_video",
  ])("accepts %s", (name) => {
    expect(isAgentDriverToolName(name)).toBe(true);
  });

  it.each([
    "starlight_create_image",
    "starlight_design_voice",
    "starlight_create_speech",
  ])("rejects obsolete identity %s", (name) => {
    expect(isAgentDriverToolName(name)).toBe(false);
  });
});
