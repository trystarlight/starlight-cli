import { describe, expect, it } from "vitest";

import {
  assertSupportedDynamicToolSchema,
  validateDynamicToolArguments,
} from "./dynamic-tool-validation.js";
import {
  isAgentDriverToolName,
  type AgentDriverToolDefinition,
} from "./protocol.js";

const modelSelection = {
  type: "object",
  additionalProperties: false,
  required: ["requested", "routeId", "catalogueVersion", "basis", "reason"],
  properties: {
    requested: { type: "string", minLength: 1, maxLength: 200 },
    routeId: { type: "string", minLength: 1, maxLength: 200 },
    catalogueVersion: { type: "string", minLength: 1, maxLength: 200 },
    basis: {
      type: "string",
      enum: ["exact-route", "exact-variant", "family", "semantic"],
    },
    reason: { type: "string", minLength: 1, maxLength: 1_000 },
  },
} as const;

const videoTool = {
  schemaVersion: "starlight.media-execution-intent.v2",
  name: "starlight_propose_video",
  capability: "text",
  description: "Propose catalogue-grounded video work.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["outputCount", "variants"],
    properties: {
      outputCount: { type: "integer", minimum: 1, maximum: 16 },
      variants: {
        type: "array",
        minItems: 1,
        maxItems: 16,
        uniqueItems: true,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["mode", "modelSelection"],
          properties: {
            mode: {
              type: "string",
              enum: ["text-to-video", "image-to-video", "draft-enhance"],
            },
            prompt: { type: "string", minLength: 1, maxLength: 4_000 },
            durationSeconds: { type: "integer", minimum: 1, maximum: 60 },
            resolution: { type: "string", enum: ["720p", "1080p"] },
            framing: {
              oneOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["kind"],
                  properties: {
                    kind: { type: "string", const: "provider-controlled" },
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["kind", "aspectRatio"],
                  properties: {
                    kind: { type: "string", const: "aspect-ratio" },
                    aspectRatio: {
                      type: "string",
                      enum: ["auto", "16:9", "9:16"],
                    },
                  },
                },
              ],
            },
            generateAudio: { type: "boolean" },
            modelSelection,
          },
          allOf: [
            {
              if: {
                required: ["mode"],
                properties: {
                  mode: { type: "string", const: "text-to-video" },
                },
              },
              then: { required: ["prompt"] },
            },
            {
              if: {
                required: ["mode"],
                properties: {
                  mode: { type: "string", const: "draft-enhance" },
                },
              },
              then: { properties: { prompt: false } },
            },
          ],
        },
      },
    },
  },
} as const satisfies AgentDriverToolDefinition;

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
  it("accepts exact multi-model output selections without literal-name routing", () => {
    const result = validateDynamicToolArguments(videoTool, {
      outputCount: 2,
      variants: [
        {
          mode: "image-to-video",
          prompt: "A restrained handheld orbit.",
          durationSeconds: 5,
          framing: { kind: "provider-controlled" },
          generateAudio: false,
          modelSelection: {
            requested: "Kling 3",
            routeId: "kling-v3-standard-image-to-video",
            catalogueVersion: "starlight.video-routes.v1",
            basis: "family",
            reason: "The family resolves to one compatible admitted route.",
          },
        },
        {
          mode: "text-to-video",
          prompt: "A quiet dawn over still water.",
          resolution: "1080p",
          modelSelection: {
            requested: "cinematic model",
            routeId: "cinematic-text-to-video",
            catalogueVersion: "starlight.video-routes.v1",
            basis: "semantic",
            reason: "The route matches the requested cinematic direction.",
          },
        },
      ],
    });

    expect(result.valid).toBe(true);
  });

  it("preserves route-specific optional framing and conditional fields", () => {
    expect(
      validateDynamicToolArguments(videoTool, {
        outputCount: 1,
        variants: [
          {
            mode: "draft-enhance",
            modelSelection: {
              requested: "enhance this draft",
              routeId: "draft-enhance-1080p",
              catalogueVersion: "starlight.video-routes.v1",
              basis: "exact-route",
              reason: "The artifact is eligible for the enhancement workflow.",
            },
          },
        ],
      }),
    ).toMatchObject({ valid: true });

    expect(
      validateDynamicToolArguments(videoTool, {
        outputCount: 1,
        variants: [
          {
            mode: "draft-enhance",
            prompt: "Replace the source intent.",
            modelSelection: {
              requested: "enhance this draft",
              routeId: "draft-enhance-1080p",
              catalogueVersion: "starlight.video-routes.v1",
              basis: "exact-route",
              reason: "The artifact is eligible for the enhancement workflow.",
            },
          },
        ],
      }),
    ).toMatchObject({
      valid: false,
      failure: { field: "variants.0.prompt" },
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

  it("rejects oversized arguments and unsupported schema keywords", () => {
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
      assertSupportedDynamicToolSchema({ type: "object", $ref: "#/$defs/a" }),
    ).toThrow(/unsupported/u);
  });
});

describe("current media tool identities", () => {
  it.each([
    "starlight_design_character_voice",
    "starlight_create_adopted_speech",
    "starlight_create_video",
    "starlight_create_talking_avatar",
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
