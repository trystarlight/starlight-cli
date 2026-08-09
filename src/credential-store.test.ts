import { describe, expect, it } from "vitest";

import { parseStoredAgentBridgeState } from "./credential-store.js";

describe("stored agent credential parser", () => {
  it("accepts the current driver scopes without returning unknown fields", () => {
    const result = parseStoredAgentBridgeState(
      JSON.stringify({
        schemaVersion: "starlight.agent-credential-store.v1",
        apiUrl: "https://app.trystarlight.io",
        webUrl: "https://app.trystarlight.io",
        ignored: "must-not-project",
        credential: {
          credentialId: "agent_credential_test",
          token: "stl_agent_secret",
          expiresAt: 10_000,
          scopes: ["character:read", "session:read", "turn:claim"],
          ignored: "must-not-project",
        },
      }),
    );

    expect(result).toEqual({
      schemaVersion: "starlight.agent-credential-store.v1",
      apiUrl: "https://app.trystarlight.io",
      webUrl: "https://app.trystarlight.io",
      credential: {
        credentialId: "agent_credential_test",
        token: "stl_agent_secret",
        expiresAt: 10_000,
        scopes: ["character:read", "session:read", "turn:claim"],
      },
    });
  });

  it("preserves customer-safe pairing facts while validating the exact stored resource", () => {
    const result = parseStoredAgentBridgeState(
      JSON.stringify({
        schemaVersion: "starlight.agent-credential-store.v1",
        apiUrl: "https://app.trystarlight.io/",
        webUrl: "https://app.trystarlight.io/",
        credential: {
          credentialId: "agent_credential_test",
          token: "stl_agent_secret",
          expiresAt: 10_000,
          scopes: ["character:read", "session:read", "turn:claim"],
          clientLabel: "Codex on this computer",
          resource: "https://app.trystarlight.io/mcp",
          workspace: {
            workspaceId: "workspace_test",
            name: "Starlight test",
          },
        },
      }),
    );

    expect(result).toMatchObject({
      apiUrl: "https://app.trystarlight.io",
      webUrl: "https://app.trystarlight.io",
      credential: {
        clientLabel: "Codex on this computer",
        resource: "https://app.trystarlight.io/mcp",
        workspace: {
          workspaceId: "workspace_test",
          name: "Starlight test",
        },
      },
    });
  });

  it.each([
    ["unknown schema", { schemaVersion: "unknown" }],
    [
      "both pending and credential",
      {
        schemaVersion: "starlight.agent-credential-store.v1",
        apiUrl: "https://app.trystarlight.io",
        webUrl: "https://app.trystarlight.io",
        pending: {},
        credential: {},
      },
    ],
    [
      "unknown scope",
      {
        schemaVersion: "starlight.agent-credential-store.v1",
        apiUrl: "https://app.trystarlight.io",
        webUrl: "https://app.trystarlight.io",
        credential: {
          credentialId: "agent_credential_test",
          token: "stl_agent_secret",
          expiresAt: 10_000,
          scopes: ["shell:execute"],
        },
      },
    ],
    [
      "mismatched resource",
      {
        schemaVersion: "starlight.agent-credential-store.v1",
        apiUrl: "https://app.trystarlight.io",
        webUrl: "https://app.trystarlight.io",
        credential: {
          credentialId: "agent_credential_test",
          token: "stl_agent_secret",
          expiresAt: 10_000,
          scopes: ["character:read", "session:read", "turn:claim"],
          resource: "https://another.example/mcp",
        },
      },
    ],
  ])("rejects %s", (_label, value) => {
    expect(() => parseStoredAgentBridgeState(JSON.stringify(value))).toThrow(
      /invalid/u,
    );
  });
});
