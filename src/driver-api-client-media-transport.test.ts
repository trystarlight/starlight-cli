import { describe, expect, it, vi } from "vitest";

import {
  AGENT_DRIVER_DEFAULT_MAXIMUM_JSON_RESPONSE_BYTES,
  AGENT_DRIVER_MEDIA_DISCOVERY_MAXIMUM_JSON_RESPONSE_BYTES,
  AgentDriverApiClient,
} from "./driver-api-client.js";
import type {
  AgentCredentialStore,
  StoredAgentBridgeState,
} from "./credential-store.js";

const credentialState: StoredAgentBridgeState = {
  schemaVersion: "starlight.agent-credential-store.v1",
  apiUrl: "https://quiet-anaconda-352.convex.site",
  webUrl: "https://app.trystarlight.io",
  credential: {
    credentialId: "agent_credential_test",
    token: "stl_agent_secret_never_print_this_value",
    expiresAt: 20_000,
    scopes: ["character:read", "session:read", "turn:claim"],
    resource: "https://app.trystarlight.io/mcp",
  },
};

function client(fetcher: typeof fetch) {
  return new AgentDriverApiClient({
    fetch: fetcher,
    now: () => 10_000,
    store: {
      read: async () => credentialState,
      write: async () => undefined,
      clear: async () => undefined,
    } satisfies AgentCredentialStore,
    requestTimeoutMs: 50,
  });
}

function schemaNode(overrides: Readonly<Record<string, unknown>> = {}) {
  const fingerprint = `sha256:${"d".repeat(64)}`;
  return {
    schemaVersion: "starlight.agent-media-schema-navigation.v1",
    endpointId: "minimax/h3/text-to-video",
    schemaFingerprint: fingerprint,
    operationCreated: false,
    providerDispatchStarted: false,
    disposition: "node",
    binding: {
      endpointId: "minimax/h3/text-to-video",
      schemaFingerprint: fingerprint,
    },
    documents: [
      {
        document: "input",
        pointer: "",
        nodeType: "object",
        byteLength: 12_784,
      },
      {
        document: "output",
        pointer: "",
        nodeType: "object",
        byteLength: 1_180,
      },
      {
        document: "openapi",
        pointer: "",
        nodeType: "object",
        byteLength: 29_440,
      },
    ],
    document: "input",
    pointer: "",
    nodeType: "object",
    byteLength: 12_784,
    valueComplete: false,
    limits: {
      maximumResultBytes: 24_000,
      maximumInlineValueBytes: 8_000,
      maximumPageEntries: 32,
    },
    ...overrides,
  };
}

const mutationInput = {
  leaseId: "lease_test",
  fencingToken: 7,
  expectedSequence: 4,
  callId: "call_media_test",
  arguments: {},
  sourceRuntimeVersion: "0.144.1",
  driverRuntimeVersion: "0.1.0",
};

describe("public driver media transport", () => {
  it("forwards arbitrary RFC 6901 navigation and Unicode scalar cursors exactly", async () => {
    const scalarText = "😀/tilde~ café 東京";
    const nextCursor = 32 + Array.from(scalarText).length;
    const fetcher = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body))).toEqual({
          leaseId: "lease_test",
          fencingToken: 7,
          endpointId: "minimax/h3/text-to-video",
          schemaFingerprint: `sha256:${"d".repeat(64)}`,
          document: "openapi",
          pointer: "/components~1schemas/~0unicode",
          cursor: 32,
        });
        return Response.json(
          schemaNode({
            document: "openapi",
            pointer: "/components~1schemas/~0unicode",
            nodeType: "string",
            byteLength: 1_200,
            scalarPage: {
              encoding: "unicode-code-points",
              cursor: 32,
              nextCursor,
              total: 80,
              text: scalarText,
            },
          }),
        );
      },
    );

    await expect(
      client(fetcher as typeof fetch).getMediaModelSchema({
        leaseId: "lease_test",
        fencingToken: 7,
        endpointId: "minimax/h3/text-to-video",
        schemaFingerprint: `sha256:${"d".repeat(64)}`,
        document: "openapi",
        pointer: "/components~1schemas/~0unicode",
        cursor: 32,
      }),
    ).resolves.toMatchObject({
      disposition: "node",
      scalarPage: { cursor: 32, nextCursor, text: scalarText },
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("preserves an explicit changed-fingerprint result without mutation ambiguity", async () => {
    const requested = `sha256:${"c".repeat(64)}`;
    const current = `sha256:${"d".repeat(64)}`;
    const fetcher = vi.fn(async () =>
      Response.json({
        schemaVersion: "starlight.agent-media-schema-navigation.v1",
        endpointId: "minimax/h3/text-to-video",
        schemaFingerprint: current,
        operationCreated: false,
        providerDispatchStarted: false,
        disposition: "schema-stale",
        code: "provider-schema-stale",
        field: "arguments.schemaFingerprint",
        requestedSchemaFingerprint: requested,
        message: "Restart bounded navigation from the current root once.",
        schemaRefreshAllowed: true,
        mustStop: false,
      }),
    );

    await expect(
      client(fetcher as typeof fetch).getMediaModelSchema({
        leaseId: "lease_test",
        fencingToken: 7,
        endpointId: "minimax/h3/text-to-video",
        schemaFingerprint: requested,
      }),
    ).resolves.toMatchObject({
      disposition: "schema-stale",
      requestedSchemaFingerprint: requested,
      schemaFingerprint: current,
      schemaRefreshAllowed: true,
      mustStop: false,
    });
  });

  it.each([
    ["malformed", new Response('{"schemaVersion":', { status: 200 })],
    [
      "oversized",
      new Response(
        JSON.stringify({
          payload: "x".repeat(
            AGENT_DRIVER_MEDIA_DISCOVERY_MAXIMUM_JSON_RESPONSE_BYTES,
          ),
        }),
        { status: 200 },
      ),
    ],
    [
      "oversized-declared-length",
      new Response("{}", {
        status: 200,
        headers: {
          "content-length": String(
            AGENT_DRIVER_MEDIA_DISCOVERY_MAXIMUM_JSON_RESPONSE_BYTES + 1,
          ),
        },
      }),
    ],
  ])(
    "fails closed on a %s discovery read as a platform failure",
    async (_label, response) => {
      const fetcher = vi.fn(async () => response);
      await expect(
        client(fetcher as typeof fetch).getMediaModelSchema({
          leaseId: "lease_test",
          fencingToken: 7,
          endpointId: "minimax/h3/text-to-video",
        }),
      ).rejects.toMatchObject({ code: "platform-failure", status: 200 });
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it("enforces the 4 MiB general JSON response boundary", async () => {
    expect(AGENT_DRIVER_DEFAULT_MAXIMUM_JSON_RESPONSE_BYTES).toBe(4_194_304);
    const fetcher = vi.fn(
      async () =>
        new Response("{}", {
          status: 200,
          headers: {
            "content-length": String(
              AGENT_DRIVER_DEFAULT_MAXIMUM_JSON_RESPONSE_BYTES + 1,
            ),
          },
        }),
    );
    await expect(
      client(fetcher as typeof fetch).getCredentialContext(),
    ).rejects.toMatchObject({ code: "platform-failure", status: 200 });
  });

  it("classifies malformed successful proposal and binding mutations as ambiguous", async () => {
    const malformedProposal = vi.fn(async () =>
      Response.json({ schemaVersion: "starlight.media-execution-result.v1" }),
    );
    await expect(
      client(malformedProposal as typeof fetch).proposeMediaExecution(
        mutationInput,
      ),
    ).rejects.toMatchObject({ code: "outcome-ambiguous" });
    expect(malformedProposal).toHaveBeenCalledOnce();

    const malformedBinding = vi.fn(async () =>
      Response.json({ schemaVersion: "starlight.media-schema-binding.v2" }),
    );
    await expect(
      client(malformedBinding as typeof fetch).prepareMediaSchemaBinding(
        mutationInput,
      ),
    ).rejects.toMatchObject({ code: "outcome-ambiguous" });
    expect(malformedBinding).toHaveBeenCalledOnce();
  });

  it("classifies an oversized successful mutation as ambiguous without retrying", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response("{}", {
          status: 200,
          headers: {
            "content-length": String(
              AGENT_DRIVER_DEFAULT_MAXIMUM_JSON_RESPONSE_BYTES + 1,
            ),
          },
        }),
    );
    await expect(
      client(fetcher as typeof fetch).proposeMediaExecution(mutationInput),
    ).rejects.toMatchObject({
      code: "outcome-ambiguous",
      status: 200,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("preserves typed ambiguous media failure without retrying", async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        {
          schemaVersion: "starlight.agent-media-tool-failure.v1",
          code: "outcome-ambiguous",
          phase: "outcome-ambiguous",
          message:
            "Starlight could not confirm whether the durable proposal was created.",
          accepted: false,
          operationCreated: false,
          providerDispatchStarted: false,
          mechanicallyRetryable: false,
          requiresUserClarification: false,
          mustStop: true,
          schemaRefreshAllowed: false,
          correlationId: "failure_00000000-0000-4000-8000-000000000005",
        },
        { status: 500 },
      ),
    );
    await expect(
      client(fetcher as typeof fetch).proposeMediaExecution(mutationInput),
    ).rejects.toMatchObject({
      code: "media-tool-failure",
      mediaFailure: {
        code: "outcome-ambiguous",
        phase: "outcome-ambiguous",
        mustStop: true,
      },
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([400, 500])(
    "keeps an unknown HTTP %s mutation failure out of invalid-argument handling",
    async (status) => {
      const fetcher = vi.fn(async () =>
        Response.json({ error: "unknown-platform-failure" }, { status }),
      );
      await expect(
        client(fetcher as typeof fetch).proposeMediaExecution(mutationInput),
      ).rejects.toMatchObject({
        code: "platform-failure",
        status,
      });
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it("preserves a provider-schema-invalid mutation response as a typed media failure", async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        {
          schemaVersion: "starlight.agent-media-tool-failure.v1",
          code: "provider-schema-invalid",
          phase: "provider-schema",
          message: "providerInput.duration is required.",
          field: "arguments.variants.0.providerInput.duration",
          accepted: false,
          operationCreated: false,
          providerDispatchStarted: false,
          mechanicallyRetryable: true,
          requiresUserClarification: false,
          mustStop: false,
          schemaRefreshAllowed: false,
          nextEventSequence: 5,
        },
        { status: 422 },
      ),
    );
    await expect(
      client(fetcher as typeof fetch).proposeMediaExecution(mutationInput),
    ).rejects.toMatchObject({
      code: "media-tool-failure",
      mediaFailure: {
        code: "provider-schema-invalid",
        phase: "provider-schema",
        field: "arguments.variants.0.providerInput.duration",
        mechanicallyRetryable: true,
        mustStop: false,
      },
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
