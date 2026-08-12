import { describe, expect, it, vi } from "vitest";

import type {
  AgentCredentialStore,
  StoredAgentBridgeState,
} from "./credential-store.js";
import { AgentBridgeClient } from "./auth-client.js";

function memoryStore(initial: StoredAgentBridgeState | null = null) {
  let state = initial;
  const store: AgentCredentialStore = {
    read: vi.fn(async () => state),
    write: vi.fn(async (value) => {
      state = value;
    }),
    clear: vi.fn(async () => {
      state = null;
    }),
  };
  return { store, state: () => state };
}

describe("agent bridge client", () => {
  it("precommits distinct hashes and never returns or persists secrets outside the credential store", async () => {
    const memory = memoryStore();
    let sequence = 0;
    const fetcher = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, string>;
        const state = memory.state();
        expect(state).toBeNull();
        expect(body["requestSecretHash"]).toMatch(/^[0-9a-f]{64}$/);
        expect(body["credentialTokenHash"]).toMatch(/^[0-9a-f]{64}$/);
        expect(body["requestSecretHash"]).not.toBe(body["credentialTokenHash"]);
        expect(body["resource"]).toBe("https://app.example.com/mcp");
        return new Response(
          JSON.stringify({
            requestId: "agent_connect_11111111-1111-4111-8111-111111111111",
            expiresAt: Date.parse("2026-07-15T06:10:00.000Z"),
            verificationPath:
              "/agent/connect?request=agent_connect_11111111-1111-4111-8111-111111111111",
          }),
          { status: 201 },
        );
      },
    );
    const client = new AgentBridgeClient({
      store: memory.store,
      fetch: fetcher as typeof fetch,
      now: () => Date.parse("2026-07-15T06:00:00.000Z"),
      randomBytes: () => Buffer.alloc(32, sequence++),
    });

    const result = await client.startLogin({
      apiUrl: "https://api.example.com",
      webUrl: "https://app.example.com",
      clientLabel: "Codex on MacBook Air",
    });

    expect(result).toMatchObject({
      status: "awaiting-approval",
      verificationUrl: expect.stringContaining("/agent/connect?request="),
      resource: "https://app.example.com/mcp",
      scopes: [
        "character:read",
        "character:write",
        "session:read",
        "turn:claim",
      ],
    });
    const stored = memory.state();
    expect(stored?.pending?.requestSecret).toMatch(/^stl_connect_/);
    expect(stored?.pending?.credentialToken).toMatch(/^stl_agent_/);
    expect(JSON.stringify(result)).not.toContain(
      stored?.pending?.requestSecret,
    );
    expect(JSON.stringify(result)).not.toContain(
      stored?.pending?.credentialToken,
    );
  });

  it("keeps a pending exchange recoverable and then stores the precommitted credential", async () => {
    const pending: StoredAgentBridgeState = {
      schemaVersion: "starlight.agent-credential-store.v1",
      apiUrl: "https://api.example.com",
      webUrl: "https://app.example.com",
      pending: {
        requestId: "agent_connect_request",
        requestSecret: "stl_connect_request-secret",
        credentialToken: "stl_agent_credential-secret",
        expiresAt: 2_000,
      },
    };
    const memory = memoryStore(pending);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "pending" }), { status: 202 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "connected",
            credentialId: "agent_credential_123",
            expiresAt: 1_000_000,
            scopes: ["character:read", "session:read", "turn:claim"],
            clientLabel: "Codex on MacBook Air",
            resource: "https://app.example.com/mcp",
            workspace: {
              workspaceId: "workspace_test",
              name: "Starlight test",
            },
          }),
          { status: 200 },
        ),
      );
    const client = new AgentBridgeClient({
      store: memory.store,
      fetch: fetcher as typeof fetch,
      now: () => 1_000,
    });

    await expect(client.completeLogin()).resolves.toMatchObject({
      status: "awaiting-approval",
    });
    expect(memory.state()?.pending?.credentialToken).toBe(
      "stl_agent_credential-secret",
    );
    await expect(client.completeLogin()).resolves.toMatchObject({
      status: "succeeded",
      credentialId: "agent_credential_123",
      resource: "https://app.example.com/mcp",
      workspace: {
        workspaceId: "workspace_test",
        name: "Starlight test",
      },
    });
    expect(memory.state()).toMatchObject({
      credential: {
        credentialId: "agent_credential_123",
        token: "stl_agent_credential-secret",
        scopes: ["character:read", "session:read", "turn:claim"],
        clientLabel: "Codex on MacBook Air",
        resource: "https://app.example.com/mcp",
        workspace: {
          workspaceId: "workspace_test",
          name: "Starlight test",
        },
      },
    });
    expect(memory.state()?.pending).toBeUndefined();
  });

  it("does not orphan an active or pending credential by silently starting over", async () => {
    const active = memoryStore({
      schemaVersion: "starlight.agent-credential-store.v1",
      apiUrl: "https://api.example.com",
      webUrl: "https://app.example.com",
      credential: {
        credentialId: "agent_credential_active",
        token: "stl_agent_active-token",
        expiresAt: 2_000,
        scopes: ["character:read"],
      },
    });
    const fetcher = vi.fn();
    const activeClient = new AgentBridgeClient({
      store: active.store,
      fetch: fetcher as typeof fetch,
      now: () => 1_000,
    });
    const input = {
      apiUrl: "https://api.example.com",
      webUrl: "https://app.example.com",
      clientLabel: "Codex",
    };

    await expect(activeClient.startLogin(input)).rejects.toThrow(
      "already connected",
    );
    expect(fetcher).not.toHaveBeenCalled();

    const pending = memoryStore({
      schemaVersion: "starlight.agent-credential-store.v1",
      apiUrl: input.apiUrl,
      webUrl: input.webUrl,
      pending: {
        requestId: "agent_connect_pending",
        requestSecret: "stl_connect_pending",
        credentialToken: "stl_agent_pending",
        expiresAt: 2_000,
      },
    });
    const pendingClient = new AgentBridgeClient({
      store: pending.store,
      fetch: fetcher as typeof fetch,
      now: () => 1_000,
    });
    await expect(pendingClient.startLogin(input)).rejects.toThrow(
      "already pending",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("revokes remotely before clearing the local credential", async () => {
    const memory = memoryStore({
      schemaVersion: "starlight.agent-credential-store.v1",
      apiUrl: "https://api.example.com",
      webUrl: "https://app.example.com",
      credential: {
        credentialId: "agent_credential_123",
        token: "stl_agent_revocable-token",
        expiresAt: 2_000,
        scopes: ["character:read"],
      },
    });
    const fetcher = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(memory.store.clear).not.toHaveBeenCalled();
        expect(new Headers(init?.headers).get("x-starlight-resource")).toBe(
          "https://app.example.com/mcp",
        );
        return new Response(
          JSON.stringify({
            schemaVersion: "starlight.agent-auth.v1",
            status: "revoked",
          }),
        );
      },
    );
    const client = new AgentBridgeClient({
      store: memory.store,
      fetch: fetcher as typeof fetch,
      now: () => 1_000,
    });

    await expect(client.logout()).resolves.toMatchObject({ connected: false });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.example.com/agent/v1/auth/revoke",
      expect.objectContaining({ method: "POST" }),
    );
    expect(memory.state()).toBeNull();
    expect(memory.store.clear).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "an explicit remote rejection",
      () => Promise.resolve(new Response("rejected", { status: 401 })),
    ],
    [
      "an ambiguous network failure",
      () => Promise.reject(new TypeError("connection closed")),
    ],
    [
      "an ambiguous successful response",
      () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              schemaVersion: "starlight.agent-auth.v1",
              status: "pending",
            }),
          ),
        ),
    ],
  ])("preserves exact local state after %s", async (_label, revoke) => {
    const initial: StoredAgentBridgeState = {
      schemaVersion: "starlight.agent-credential-store.v1",
      apiUrl: "https://foreign-api.example.com",
      webUrl: "https://foreign.example.com",
      credential: {
        credentialId: "agent_credential_foreign",
        token: "stl_agent_foreign-token",
        expiresAt: 2_000,
        scopes: ["character:read"],
      },
    };
    const memory = memoryStore(initial);
    const fetcher = vi.fn(revoke);
    const client = new AgentBridgeClient({
      store: memory.store,
      fetch: fetcher as typeof fetch,
      now: () => 1_000,
    });

    await expect(client.logout()).rejects.toThrow(
      "could not confirm remote credential revocation; local access was preserved",
    );
    expect(memory.state()).toEqual(initial);
    expect(memory.store.clear).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a stored credential",
      {
        schemaVersion: "starlight.agent-credential-store.v1" as const,
        apiUrl: "https://foreign-api.example.com",
        webUrl: "https://foreign.example.com",
        credential: {
          credentialId: "agent_credential_foreign",
          token: "stl_agent_foreign-token",
          expiresAt: 2_000,
          scopes: ["character:read" as const],
        },
      },
    ],
    [
      "pending pairing state",
      {
        schemaVersion: "starlight.agent-credential-store.v1" as const,
        apiUrl: "https://foreign-api.example.com",
        webUrl: "https://foreign.example.com",
        pending: {
          requestId: "agent_connect_foreign",
          requestSecret: "stl_connect_foreign",
          credentialToken: "stl_agent_pending-foreign",
          expiresAt: 2_000,
        },
      },
    ],
  ])(
    "clears %s locally once without reading or using the network",
    async (_label, initial) => {
      const memory = memoryStore(initial);
      const fetcher = vi.fn();
      const client = new AgentBridgeClient({
        store: memory.store,
        fetch: fetcher as typeof fetch,
        now: () => 1_000,
      });

      await expect(client.clearLocalCredentials()).resolves.toEqual({
        schemaVersion: "starlight.agent-auth.v1",
        status: "succeeded",
        connected: false,
        remoteRevocation: "skipped",
        localCredentialsCleared: true,
        note: "Local Starlight agent credentials and pending pairing state were cleared.",
        warning:
          "Remote revocation was skipped. A still-valid remote credential may remain active until revoked or expired.",
      });
      expect(memory.store.read).not.toHaveBeenCalled();
      expect(memory.store.clear).toHaveBeenCalledOnce();
      expect(fetcher).not.toHaveBeenCalled();
      expect(memory.state()).toBeNull();
    },
  );

  it("leaves status disconnected and permits a fresh pair request after explicit local recovery", async () => {
    const memory = memoryStore({
      schemaVersion: "starlight.agent-credential-store.v1",
      apiUrl: "http://127.0.0.1:4100",
      webUrl: "http://127.0.0.1:4100",
      credential: {
        credentialId: "agent_credential_stale-workspace",
        token: "stl_agent_stale-workspace",
        expiresAt: 2_000,
        scopes: ["character:read"],
      },
    });
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            requestId: "agent_connect_fresh-workspace",
            expiresAt: 3_000,
            verificationPath:
              "/agent/connect?request=agent_connect_fresh-workspace",
          }),
          { status: 201 },
        ),
    );
    const client = new AgentBridgeClient({
      store: memory.store,
      fetch: fetcher as typeof fetch,
      now: () => 1_000,
      randomBytes: () => Buffer.alloc(32, 1),
    });

    await client.clearLocalCredentials();
    expect(fetcher).not.toHaveBeenCalled();
    await expect(client.status()).resolves.toEqual({
      schemaVersion: "starlight.agent-auth.v1",
      status: "succeeded",
      connected: false,
    });
    await expect(
      client.startLogin({
        apiUrl: "http://127.0.0.1:4200",
        webUrl: "http://127.0.0.1:4200",
        clientLabel: "Codex after local recovery",
      }),
    ).resolves.toMatchObject({
      status: "awaiting-approval",
      requestId: "agent_connect_fresh-workspace",
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(memory.state()?.pending?.requestId).toBe(
      "agent_connect_fresh-workspace",
    );
  });

  it("reports exact local clearing failure without false success or network access", async () => {
    const store: AgentCredentialStore = {
      read: vi.fn(),
      write: vi.fn(),
      clear: vi.fn(async () => {
        throw new Error("Keychain denied the exact item deletion");
      }),
    };
    const fetcher = vi.fn();
    const client = new AgentBridgeClient({
      store,
      fetch: fetcher as typeof fetch,
    });

    await expect(client.clearLocalCredentials()).rejects.toThrow(
      "local recovery did not complete",
    );
    expect(store.clear).toHaveBeenCalledOnce();
    expect(store.read).not.toHaveBeenCalled();
    expect(store.write).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
