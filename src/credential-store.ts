import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const KEYCHAIN_SERVICE = "io.trystarlight.cli.agent-bridge";
const KEYCHAIN_ACCOUNT = "starlight-agent";

export type AgentCredentialScope =
  | "character:read"
  | "character:write"
  | "plan:write"
  | "operation:read"
  | "reference:write"
  | "session:read"
  | "turn:claim";

export interface StoredAgentBridgeState {
  readonly schemaVersion: "starlight.agent-credential-store.v1";
  readonly apiUrl: string;
  readonly webUrl: string;
  readonly pending?: {
    readonly requestId: string;
    readonly requestSecret: string;
    readonly credentialToken: string;
    readonly expiresAt: number;
  };
  readonly credential?: {
    readonly credentialId: string;
    readonly token: string;
    readonly expiresAt: number;
    readonly scopes: readonly AgentCredentialScope[];
    readonly clientLabel?: string;
    readonly resource?: string;
    readonly workspace?: {
      readonly workspaceId: string;
      readonly name: string;
    };
  };
}

export interface AgentCredentialStore {
  read(): Promise<StoredAgentBridgeState | null>;
  write(state: StoredAgentBridgeState): Promise<void>;
  clear(): Promise<void>;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, field: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Stored Starlight ${field} is invalid`);
  }
  return value;
}

function requiredTimestamp(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Stored Starlight ${field} is invalid`);
  }
  return value;
}

function storedBaseUrl(value: unknown, field: string) {
  const raw = requiredText(value, field);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Stored Starlight ${field} is invalid`);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error(`Stored Starlight ${field} is invalid`);
  }
  return url.toString().replace(/\/$/u, "");
}

const agentCredentialScopes = new Set<AgentCredentialScope>([
  "character:read",
  "character:write",
  "plan:write",
  "operation:read",
  "reference:write",
  "session:read",
  "turn:claim",
]);

function scopes(value: unknown) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.some(
      (scope) =>
        typeof scope !== "string" ||
        !agentCredentialScopes.has(scope as AgentCredentialScope),
    )
  ) {
    throw new Error("Stored Starlight credential scopes are invalid");
  }
  return value as AgentCredentialScope[];
}

export function parseStoredAgentBridgeState(
  raw: string,
): StoredAgentBridgeState {
  const value = JSON.parse(raw) as unknown;
  if (
    !isRecord(value) ||
    value["schemaVersion"] !== "starlight.agent-credential-store.v1"
  ) {
    throw new Error("Stored Starlight agent credential state is invalid");
  }
  const pending = value["pending"];
  const credential = value["credential"];
  if ((pending === undefined) === (credential === undefined)) {
    throw new Error("Stored Starlight agent credential state is invalid");
  }
  const apiUrl = storedBaseUrl(value["apiUrl"], "agent API URL");
  const webUrl = storedBaseUrl(value["webUrl"], "web URL");
  return {
    schemaVersion: "starlight.agent-credential-store.v1",
    apiUrl,
    webUrl,
    ...(pending === undefined
      ? {}
      : isRecord(pending)
        ? {
            pending: {
              requestId: requiredText(
                pending["requestId"],
                "connection request ID",
              ),
              requestSecret: requiredText(
                pending["requestSecret"],
                "connection request secret",
              ),
              credentialToken: requiredText(
                pending["credentialToken"],
                "pending credential token",
              ),
              expiresAt: requiredTimestamp(
                pending["expiresAt"],
                "connection expiry",
              ),
            },
          }
        : (() => {
            throw new Error("Stored Starlight pending connection is invalid");
          })()),
    ...(credential === undefined
      ? {}
      : isRecord(credential)
        ? {
            credential: {
              credentialId: requiredText(
                credential["credentialId"],
                "credential ID",
              ),
              token: requiredText(credential["token"], "credential token"),
              expiresAt: requiredTimestamp(
                credential["expiresAt"],
                "credential expiry",
              ),
              scopes: scopes(credential["scopes"]),
              ...(credential["clientLabel"] === undefined
                ? {}
                : {
                    clientLabel: requiredText(
                      credential["clientLabel"],
                      "credential client label",
                    ),
                  }),
              ...(credential["resource"] === undefined
                ? {}
                : credential["resource"] ===
                    new URL("/mcp", `${webUrl}/`).toString()
                  ? { resource: credential["resource"] }
                  : (() => {
                      throw new Error(
                        "Stored Starlight credential resource is invalid",
                      );
                    })()),
              ...(credential["workspace"] === undefined
                ? {}
                : isRecord(credential["workspace"])
                  ? {
                      workspace: {
                        workspaceId: requiredText(
                          credential["workspace"]["workspaceId"],
                          "credential workspace ID",
                        ),
                        name: requiredText(
                          credential["workspace"]["name"],
                          "credential workspace name",
                        ),
                      },
                    }
                  : (() => {
                      throw new Error(
                        "Stored Starlight credential workspace is invalid",
                      );
                    })()),
            },
          }
        : (() => {
            throw new Error("Stored Starlight credential is invalid");
          })()),
  };
}

function isMissingKeychainItem(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === 44 || error.code === "44")
  );
}

export class MacKeychainAgentCredentialStore implements AgentCredentialStore {
  async read() {
    try {
      const result = await execFileAsync("security", [
        "find-generic-password",
        "-a",
        KEYCHAIN_ACCOUNT,
        "-s",
        KEYCHAIN_SERVICE,
        "-w",
      ]);
      return parseStoredAgentBridgeState(result.stdout.trim());
    } catch (error) {
      if (isMissingKeychainItem(error)) return null;
      throw new Error(
        "Starlight could not read the macOS Keychain credential",
        { cause: error },
      );
    }
  }

  async write(state: StoredAgentBridgeState) {
    await execFileAsync("security", [
      "add-generic-password",
      "-U",
      "-a",
      KEYCHAIN_ACCOUNT,
      "-s",
      KEYCHAIN_SERVICE,
      "-w",
      JSON.stringify(state),
    ]);
  }

  async clear() {
    try {
      await execFileAsync("security", [
        "delete-generic-password",
        "-a",
        KEYCHAIN_ACCOUNT,
        "-s",
        KEYCHAIN_SERVICE,
      ]);
    } catch (error) {
      if (!isMissingKeychainItem(error)) {
        throw new Error(
          "Starlight could not clear the macOS Keychain credential",
          {
            cause: error,
          },
        );
      }
    }
  }
}

export function createDefaultAgentCredentialStore(): AgentCredentialStore {
  if (process.platform !== "darwin") {
    throw new Error("The Starlight CLI is supported on macOS only");
  }
  return new MacKeychainAgentCredentialStore();
}
