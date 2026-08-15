import { createHash, randomBytes } from "node:crypto";

import {
  createDefaultAgentCredentialStore,
  type AgentCredentialScope,
  type AgentCredentialStore,
  type StoredAgentBridgeState,
} from "./credential-store.js";

type Fetch = typeof fetch;

export interface AgentBridgeLoginInput {
  readonly apiUrl: string;
  readonly webUrl: string;
  readonly clientLabel: string;
}

export interface AgentBridgeClientDependencies {
  readonly store?: AgentCredentialStore;
  readonly fetch?: Fetch;
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Buffer;
}

function normalizeBaseUrl(value: string, label: string) {
  const url = new URL(value);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error(
      `${label} must be a root HTTPS URL unless it targets localhost`,
    );
  }
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/u, "");
}

function resourceFor(webUrl: string) {
  return new URL("/mcp", `${webUrl}/`).toString();
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function record(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} returned an invalid response`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requiredText(value: unknown, label: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is missing`);
  }
  return value;
}

function requiredNumber(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

const supportedAgentScopes = new Set<AgentCredentialScope>([
  "character:read",
  "character:write",
  "plan:write",
  "operation:read",
  "reference:write",
  "session:read",
  "turn:claim",
]);

function requiredScopes(value: unknown) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.some(
      (scope) =>
        typeof scope !== "string" ||
        !supportedAgentScopes.has(scope as AgentCredentialScope),
    )
  ) {
    throw new Error("Agent credential scopes are invalid");
  }
  return value as AgentCredentialScope[];
}

function randomSecret(
  prefix: "stl_connect_" | "stl_agent_",
  bytes: (size: number) => Buffer,
) {
  return `${prefix}${bytes(32).toString("base64url")}`;
}

export class AgentBridgeClient {
  private readonly store: AgentCredentialStore;
  private readonly fetcher: Fetch;
  private readonly now: () => number;
  private readonly bytes: (size: number) => Buffer;

  constructor(dependencies: AgentBridgeClientDependencies = {}) {
    this.store = dependencies.store ?? createDefaultAgentCredentialStore();
    this.fetcher = dependencies.fetch ?? fetch;
    this.now = dependencies.now ?? Date.now;
    this.bytes = dependencies.randomBytes ?? randomBytes;
  }

  async startLogin(input: AgentBridgeLoginInput) {
    const existing = await this.store.read();
    if (
      existing?.credential !== undefined &&
      existing.credential.expiresAt > this.now()
    ) {
      throw new Error(
        "Starlight agent is already connected; run auth logout before reconnecting",
      );
    }
    if (
      existing?.pending !== undefined &&
      existing.pending.expiresAt > this.now()
    ) {
      throw new Error(
        "A Starlight connection is already pending; approve it and run auth complete, or run auth logout before starting over",
      );
    }
    const apiUrl = normalizeBaseUrl(input.apiUrl, "Agent API URL");
    const webUrl = normalizeBaseUrl(input.webUrl, "Starlight web URL");
    const clientLabel = input.clientLabel.trim();
    if (clientLabel.length < 1 || clientLabel.length > 80) {
      throw new Error("Agent client label must be between 1 and 80 characters");
    }
    const requestSecret = randomSecret("stl_connect_", this.bytes);
    const credentialToken = randomSecret("stl_agent_", this.bytes);
    const response = await this.fetcher(`${apiUrl}/agent/v1/auth/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestSecretHash: sha256(requestSecret),
        credentialTokenHash: sha256(credentialToken),
        credentialTokenPrefix: credentialToken.slice(0, 20),
        clientLabel,
        resource: resourceFor(webUrl),
      }),
    });
    const body = record(await response.json(), "Agent connection start");
    if (!response.ok)
      throw new Error("Starlight could not start the agent connection");
    const requestId = requiredText(
      body["requestId"],
      "Agent connection request ID",
    );
    const expiresAt = requiredNumber(
      body["expiresAt"],
      "Agent connection expiry",
    );
    const verificationPath = requiredText(
      body["verificationPath"],
      "Agent verification path",
    );
    const state: StoredAgentBridgeState = {
      schemaVersion: "starlight.agent-credential-store.v1",
      apiUrl,
      webUrl,
      pending: { requestId, requestSecret, credentialToken, expiresAt },
    };
    await this.store.write(state);
    return {
      schemaVersion: "starlight.agent-auth.v1" as const,
      status: "awaiting-approval" as const,
      requestId,
      clientLabel,
      verificationUrl: new URL(verificationPath, `${webUrl}/`).toString(),
      resource: resourceFor(webUrl),
      expiresAt: new Date(expiresAt).toISOString(),
      scopes: [
        "character:read",
        "character:write",
        "session:read",
        "turn:claim",
      ] as const,
      next: {
        action: "approve-agent-connection",
        label:
          "Open the verification URL and approve this bounded workspace driver",
        requiresHuman: true,
      },
    };
  }

  async completeLogin() {
    const state = await this.store.read();
    if (state?.pending === undefined)
      throw new Error("No pending Starlight connection was found");
    if (state.pending.expiresAt <= this.now()) {
      await this.store.clear();
      throw new Error(
        "The pending Starlight connection expired; start a fresh login",
      );
    }
    const response = await this.fetcher(
      `${state.apiUrl}/agent/v1/auth/exchange`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${state.pending.requestSecret}` },
      },
    );
    const body = record(await response.json(), "Agent connection exchange");
    if (response.status === 202 && body["status"] === "pending") {
      return {
        schemaVersion: "starlight.agent-auth.v1" as const,
        status: "awaiting-approval" as const,
        next: {
          action: "approve-agent-connection",
          label:
            "Approve the pending connection in Starlight, then run auth complete again",
          requiresHuman: true,
        },
      };
    }
    if (!response.ok || body["status"] !== "connected") {
      throw new Error("Starlight could not complete the agent connection");
    }
    const credentialId = requiredText(
      body["credentialId"],
      "Agent credential ID",
    );
    const expiresAt = requiredNumber(
      body["expiresAt"],
      "Agent credential expiry",
    );
    const scopes = requiredScopes(body["scopes"]);
    const resource = requiredText(
      body["resource"],
      "Agent credential resource",
    );
    const expectedResource = resourceFor(state.webUrl);
    if (resource !== expectedResource) {
      throw new Error("Starlight returned a credential for another resource");
    }
    const clientLabel = requiredText(
      body["clientLabel"],
      "Agent credential client label",
    );
    const workspace = record(body["workspace"], "Agent credential workspace");
    const workspaceId = requiredText(
      workspace["workspaceId"],
      "Agent credential workspace ID",
    );
    const workspaceName = requiredText(
      workspace["name"],
      "Agent credential workspace name",
    );
    await this.store.write({
      schemaVersion: state.schemaVersion,
      apiUrl: state.apiUrl,
      webUrl: state.webUrl,
      credential: {
        credentialId,
        token: state.pending.credentialToken,
        expiresAt,
        scopes,
        clientLabel,
        resource,
        workspace: {
          workspaceId,
          name: workspaceName,
        },
      },
    });
    return {
      schemaVersion: "starlight.agent-auth.v1" as const,
      status: "succeeded" as const,
      credentialId,
      clientLabel,
      resource,
      workspace: {
        workspaceId,
        name: workspaceName,
      },
      expiresAt: new Date(expiresAt).toISOString(),
      scopes,
      textCapability:
        scopes.includes("session:read") && scopes.includes("turn:claim"),
      next: {
        action: "start-driver",
        label: "Run starlight driver start to claim queued workspace turns",
        requiresHuman: false,
      },
    };
  }

  async status() {
    const state = await this.store.read();
    if (
      state?.credential !== undefined &&
      state.credential.expiresAt > this.now()
    ) {
      return {
        schemaVersion: "starlight.agent-auth.v1" as const,
        status: "succeeded" as const,
        connected: true,
        credentialId: state.credential.credentialId,
        clientLabel: state.credential.clientLabel ?? null,
        resource: state.credential.resource ?? null,
        workspace: state.credential.workspace ?? null,
        expiresAt: new Date(state.credential.expiresAt).toISOString(),
        scopes: state.credential.scopes,
        textCapability:
          state.credential.scopes.includes("session:read") &&
          state.credential.scopes.includes("turn:claim") &&
          state.credential.resource === resourceFor(state.webUrl),
      };
    }
    if (state?.pending !== undefined && state.pending.expiresAt > this.now()) {
      return {
        schemaVersion: "starlight.agent-auth.v1" as const,
        status: "awaiting-approval" as const,
        connected: false,
        requestId: state.pending.requestId,
        expiresAt: new Date(state.pending.expiresAt).toISOString(),
      };
    }
    return {
      schemaVersion: "starlight.agent-auth.v1" as const,
      status: "succeeded" as const,
      connected: false,
    };
  }

  async logout() {
    const state = await this.store.read();
    if (
      state?.credential !== undefined &&
      state.credential.expiresAt > this.now()
    ) {
      try {
        const response = await this.fetcher(
          `${state.apiUrl}/agent/v1/auth/revoke`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${state.credential.token}`,
              "x-starlight-resource": resourceFor(state.webUrl),
            },
          },
        );
        if (!response.ok) throw new Error("Remote revocation was rejected");
        const body = record(
          await response.json(),
          "Agent credential revocation",
        );
        if (
          body["schemaVersion"] !== "starlight.agent-auth.v1" ||
          body["status"] !== "revoked"
        ) {
          throw new Error("Remote revocation was not confirmed");
        }
      } catch (error) {
        throw new Error(
          "Starlight could not confirm remote credential revocation; local access was preserved so logout can be retried",
          { cause: error },
        );
      }
    }
    await this.store.clear();
    return {
      schemaVersion: "starlight.agent-auth.v1" as const,
      status: "succeeded" as const,
      connected: false,
      note: "Remote credential revoked and local agent credentials cleared.",
    };
  }

  async clearLocalCredentials() {
    try {
      await this.store.clear();
    } catch (error) {
      throw new Error(
        "Starlight could not clear local agent credentials; local recovery did not complete",
        { cause: error },
      );
    }
    return {
      schemaVersion: "starlight.agent-auth.v1" as const,
      status: "succeeded" as const,
      connected: false,
      remoteRevocation: "skipped" as const,
      localCredentialsCleared: true,
      note: "Local Starlight agent credentials and pending pairing state were cleared.",
      warning:
        "Remote revocation was skipped. A still-valid remote credential may remain active until revoked or expired.",
    };
  }

  async isConnected() {
    const state = await this.store.read();
    return (
      state?.credential !== undefined && state.credential.expiresAt > this.now()
    );
  }
}
