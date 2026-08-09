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
});
