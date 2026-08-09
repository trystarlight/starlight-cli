import { describe, expect, it } from "vitest";

import { parseAgentDriverSessionContext } from "./driver-api-client.js";

function context(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    behaviorProfileVersion: "starlight.creative-driver-behavior-profile.v2",
    workingSet: {
      schemaVersion: "starlight.agent-working-set.v1",
      subject: { kind: "unsaved", binding: null },
      budget: { availability: "unavailable" },
      operations: [],
      fencing: { turnVersion: 1, turnEventSequence: 2 },
    },
    session: { sessionId: "session_1", title: "Session" },
    messages: [],
    activeTurn: {
      turnId: "turn_1",
      status: "running",
      eventSequence: 2,
      capability: "text",
      routing: {
        policyVersion: "starlight.agent-routing.v1",
        executionProfile: "auto",
        reasoningDepth: "adapter-default",
        minimumCapability: "text",
        requiredInputCapabilities: [],
        reason: "automatic-capable-conversation",
      },
      requiredInputCapabilities: [],
    },
    ...overrides,
  };
}

function currentInstructions(toolName = "starlight_save_character") {
  return {
    schemaVersion: "starlight.agent-driver-instructions.v1",
    text: "Follow the authenticated Starlight session contract.",
    tools: [
      {
        schemaVersion: "starlight.agent-tool.v1",
        name: toolName,
        capability: "text",
        description: "Apply a durable action.",
        inputSchema: { type: "object" },
      },
    ],
  };
}

describe("driver protocol negotiation", () => {
  it("accepts the current protocol with server-owned instructions and tool schemas", () => {
    expect(
      parseAgentDriverSessionContext(
        context({
          driverProtocolVersion: "1.0.0",
          driverInstructions: currentInstructions(),
        }),
      ),
    ).toMatchObject({
      driverProtocolVersion: "1.0.0",
      driverInstructions: {
        schemaVersion: "starlight.agent-driver-instructions.v1",
        tools: [{ name: "starlight_save_character" }],
      },
    });
  });

  it("keeps the explicitly supported legacy response parseable", () => {
    expect(parseAgentDriverSessionContext(context())).not.toHaveProperty(
      "driverInstructions",
    );
  });

  it("preserves server-owned catalogue, media index, and current media tools", () => {
    const videoCatalogue = {
      schemaVersion: "starlight.agent-video-catalogue.v1",
      catalogueVersion: "starlight.video-routes.v1",
      routes: [
        {
          routeId: "cinematic-image-to-video",
          familyId: "cinematic",
          selectorHints: ["Cinematic", "Cinematic Standard"],
          mode: "image-to-video",
          inputs: {
            framing: { kind: "provider-controlled", values: ["auto"] },
          },
        },
      ],
    };
    const sessionMedia = {
      schemaVersion: "starlight.agent-session-media.v1",
      entries: [
        {
          artifactId: "artifact_video_reference",
          role: "video-output",
          ordinal: 1,
        },
      ],
    };
    const inputSchema = {
      type: "object",
      additionalProperties: false,
      required: ["outputCount", "script"],
      properties: {
        outputCount: { type: "integer", const: 1 },
        script: { type: "string", minLength: 1, maxLength: 5_000 },
      },
    };
    const parsed = parseAgentDriverSessionContext(
      context({
        driverProtocolVersion: "1.0.0",
        workingSet: {
          ...context().workingSet,
          videoCatalogue,
          sessionMedia,
        },
        driverInstructions: {
          schemaVersion: "starlight.agent-driver-instructions.v1",
          text: "Use the supplied working set and durable tools.",
          tools: [
            {
              schemaVersion: "starlight.agent-media-tools.v3",
              name: "starlight_create_adopted_speech",
              capability: "media-speech",
              description: "Create adopted speech.",
              inputSchema,
            },
          ],
        },
      }),
    );

    expect(parsed.workingSet.videoCatalogue).toEqual(videoCatalogue);
    expect(parsed.workingSet.sessionMedia).toEqual(sessionMedia);
    expect(parsed.driverInstructions).toMatchObject({
      text: "Use the supplied working set and durable tools.",
      tools: [
        {
          name: "starlight_create_adopted_speech",
          capability: "media-speech",
          inputSchema,
        },
      ],
    });
  });

  it("rejects incompatible versions and unknown tool names", () => {
    expect(() =>
      parseAgentDriverSessionContext(
        context({
          driverProtocolVersion: "2.0.0",
          driverInstructions: currentInstructions(),
        }),
      ),
    ).toThrow(/protocol version is unsupported/u);
    expect(() =>
      parseAgentDriverSessionContext(
        context({
          driverProtocolVersion: "1.0.0",
          driverInstructions: currentInstructions("unknown_tool"),
        }),
      ),
    ).toThrow(/tool name is unsupported/u);
  });

  it("rejects malformed catalogue projections and unsupported tool schemas", () => {
    expect(() =>
      parseAgentDriverSessionContext(
        context({
          workingSet: {
            ...context().workingSet,
            videoCatalogue: {
              schemaVersion: "starlight.agent-video-catalogue.v1",
              routes: "truncated",
            },
          },
        }),
      ),
    ).toThrow(/video catalogue is invalid/u);
    expect(() =>
      parseAgentDriverSessionContext(
        context({
          driverProtocolVersion: "1.0.0",
          driverInstructions: {
            ...currentInstructions(),
            tools: [
              {
                ...currentInstructions().tools[0],
                inputSchema: { type: "object", unsupportedKeyword: true },
              },
            ],
          },
        }),
      ),
    ).toThrow(/schema.*unsupported/u);
  });
});
