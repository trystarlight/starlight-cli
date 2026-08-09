import { createHash } from "node:crypto";

import type {
  AgentAttachmentProjection,
  AgentCharacterResultProjection,
  AgentCharacterToolName,
  AgentDriverAcceptedIntervention,
  AgentDriverCapability,
  AgentDriverToolDefinition,
  AgentDriverToolName,
  AgentExecutionProfile,
  AgentExecutionRoutingProjection,
  AgentInputCapability,
  AgentMediaToolName,
  AgentMediaExecutionResult,
  AgentSessionMediaResolution,
  AGENT_SESSION_MEDIA_TOOL_NAME,
  AgentMessagePart,
  AgentResponseBlockInput,
  AgentToolActionEventProjection,
  AgentWorkingSetProjection,
  CreativeDriverBehaviorContract,
} from "./protocol.js";
import { assertSupportedDynamicToolSchema } from "./dynamic-tool-validation.js";
import {
  AGENT_DRIVER_INSTRUCTIONS_SCHEMA_VERSION,
  isAgentDriverToolName,
  requireAgentWorkingSetProjection,
  requireAgentSessionMediaResolution,
  requireCreativeDriverBehaviorProfile,
} from "./protocol.js";

import {
  createDefaultAgentCredentialStore,
  type AgentCredentialStore,
  type StoredAgentBridgeState,
} from "./credential-store.js";
import { STARLIGHT_DRIVER_PROTOCOL_VERSION } from "./version.js";

type Fetch = typeof fetch;

export interface AgentDriverLease {
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly expiresAt: number;
}

interface AgentDriverTurn {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly sessionTitle: string;
  readonly turnId: string;
  readonly capability: "text" | "image";
  readonly routing: AgentExecutionRoutingProjection;
  readonly behaviorProfileVersion: CreativeDriverBehaviorContract["profileVersion"];
  readonly requiredInputCapabilities: readonly AgentInputCapability[];
  readonly userMessage: {
    readonly messageId: string;
    readonly sequence: number;
    readonly role: "user";
    readonly parts: readonly AgentMessagePart[];
    readonly text: string;
    readonly createdAt: number;
  };
  readonly queuedAt: number;
  readonly recoveryCount: number;
}

interface AgentDriverClaimedTurn extends AgentDriverTurn {
  readonly workingSet: AgentWorkingSetProjection;
}

export interface AgentDriverClaim {
  readonly turn: AgentDriverClaimedTurn;
  readonly lease: AgentDriverLease;
  readonly nextEventSequence: number;
  readonly replayed: boolean;
}

interface AgentDriverSessionContext {
  readonly behaviorProfileVersion: CreativeDriverBehaviorContract["profileVersion"];
  readonly driverProtocolVersion?: typeof STARLIGHT_DRIVER_PROTOCOL_VERSION;
  readonly driverInstructions?: {
    readonly schemaVersion: typeof AGENT_DRIVER_INSTRUCTIONS_SCHEMA_VERSION;
    readonly text: string;
    readonly tools: readonly AgentDriverToolDefinition[];
  };
  readonly workingSet: AgentWorkingSetProjection;
  readonly session: {
    readonly sessionId: string;
    readonly title: string;
  };
  readonly messages: readonly {
    readonly messageId: string;
    readonly sequence: number;
    readonly role: "user" | "assistant";
    readonly parts: readonly AgentMessagePart[];
    readonly text: string;
    readonly createdAt: number;
  }[];
  readonly activeTurn: {
    readonly turnId: string;
    readonly status: string;
    readonly eventSequence: number;
    readonly capability: "text" | "image";
    readonly routing: AgentExecutionRoutingProjection;
    readonly requiredInputCapabilities: readonly AgentInputCapability[];
  };
}

export class AgentDriverApiError extends Error {
  readonly nextEventSequence: number | null;

  constructor(
    message: string,
    readonly code:
      | "authentication-required"
      | "credential-expired"
      | "driver-capability-unavailable"
      | "resource-mismatch"
      | "lease-lost"
      | "request-rejected"
      | "outcome-ambiguous",
    readonly status: number | null,
    options: ErrorOptions & { readonly nextEventSequence?: number } = {},
  ) {
    super(message, options);
    this.name = "AgentDriverApiError";
    this.nextEventSequence = options.nextEventSequence ?? null;
  }
}

export interface AgentDriverApiClientDependencies {
  readonly store?: AgentCredentialStore;
  readonly fetch?: Fetch;
  readonly now?: () => number;
  readonly requestTimeoutMs?: number;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string) {
  if (!isRecord(value))
    throw new Error(`${label} returned an invalid response`);
  return value;
}

function text(value: unknown, label: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is missing`);
  }
  return value;
}

function string(value: unknown, label: string) {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  return value;
}

function integer(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function mediaAction(value: unknown): AgentToolActionEventProjection {
  const source = record(value, "Agent media action");
  const status = source["status"];
  if (
    source["kind"] !== "media-operation" ||
    (status !== "running" &&
      status !== "completed" &&
      status !== "failed" &&
      status !== "ambiguous")
  ) {
    throw new Error("Agent media action is invalid");
  }
  return {
    actionId: text(source["actionId"], "Agent media action ID"),
    kind: "media-operation",
    status,
    operationId: text(source["operationId"], "Agent media operation ID"),
  };
}

export function parseAgentMediaExecutionResult(
  value: unknown,
): AgentMediaExecutionResult {
  const source = record(value, "Agent media execution result");
  if (source["schemaVersion"] !== "starlight.media-execution-result.v1") {
    throw new Error("Agent media execution result schema is invalid");
  }
  const common = {
    schemaVersion: "starlight.media-execution-result.v1" as const,
    proposalId: text(source["proposalId"], "Agent media execution proposal ID"),
    nextEventSequence: integer(
      source["nextEventSequence"],
      "Agent media execution next event sequence",
    ),
    replayed: source["replayed"] === true,
  };
  if (typeof source["replayed"] !== "boolean") {
    throw new Error("Agent media execution replay status is invalid");
  }
  if (source["disposition"] === "accepted") {
    const values = source["operations"];
    if (!Array.isArray(values))
      throw new Error("Agent media execution operations are invalid");
    const requestedOutputCount = integer(
      source["requestedOutputCount"],
      "Agent media execution requested output count",
    );
    const expectedOperationCount = integer(
      source["expectedOperationCount"],
      "Agent media execution expected operation count",
    );
    if (
      requestedOutputCount < 1 ||
      expectedOperationCount < 1 ||
      values.length !== expectedOperationCount
    ) {
      throw new Error("Agent media execution operation count is invalid");
    }
    const operationIds = new Set<string>();
    const actionIds = new Set<string>();
    return {
      ...common,
      disposition: "accepted",
      requestedOutputCount,
      expectedOperationCount,
      operations: values.map((value, index) => {
        const operation = record(value, "Agent media execution operation");
        const operationId = text(
          operation["operationId"],
          "Agent media operation ID",
        );
        const actionId = text(operation["actionId"], "Agent media action ID");
        const ordinal = integer(
          operation["ordinal"],
          "Agent media operation ordinal",
        );
        if (
          ordinal !== index + 1 ||
          operationIds.has(operationId) ||
          actionIds.has(actionId)
        ) {
          throw new Error(
            "Agent media execution operation identity is invalid",
          );
        }
        operationIds.add(operationId);
        actionIds.add(actionId);
        return {
          operationId,
          actionId,
          ordinal,
          status: text(operation["status"], "Agent media operation status"),
        };
      }),
    };
  }
  if (source["disposition"] === "clarification-required") {
    const code = source["code"];
    if (
      code !== "unsupported-cardinality" &&
      code !== "subject-not-found" &&
      code !== "subject-ambiguous" &&
      code !== "canon-unavailable" &&
      code !== "reference-unavailable" &&
      code !== "prerequisite-missing" &&
      code !== "lineage-invalid" &&
      code !== "model-not-found" &&
      code !== "model-ambiguous" &&
      code !== "model-catalogue-stale" &&
      code !== "model-input-required" &&
      code !== "model-adjustment-required" &&
      code !== "model-capability-mismatch"
    ) {
      throw new Error("Agent media execution clarification code is invalid");
    }
    const values = source["candidates"];
    if (!Array.isArray(values)) {
      throw new Error(
        "Agent media execution clarification candidates are invalid",
      );
    }
    const alternativeValues = source["modelAlternatives"] ?? [];
    if (!Array.isArray(alternativeValues)) {
      throw new Error("Agent media execution model alternatives are invalid");
    }
    const adjustmentValues = source["adjustments"] ?? [];
    if (!Array.isArray(adjustmentValues)) {
      throw new Error("Agent media execution adjustments are invalid");
    }
    return {
      ...common,
      disposition: "clarification-required",
      code,
      message: text(source["message"], "Agent media execution clarification"),
      candidates: values.map((value) => {
        const candidate = record(
          value,
          "Agent media execution clarification candidate",
        );
        return {
          characterId: text(candidate["characterId"], "Agent character ID"),
          displayName: text(
            candidate["displayName"],
            "Agent character display name",
          ),
        };
      }),
      modelAlternatives: alternativeValues.map((value) => {
        const alternative = record(
          value,
          "Agent media execution model alternative",
        );
        return {
          model: text(alternative["model"], "Agent media model"),
          reason: text(
            alternative["reason"],
            "Agent media model alternative reason",
          ),
        };
      }),
      adjustments: adjustmentValues.map((value) => {
        const adjustment = record(value, "Agent media execution adjustment");
        if (adjustment["field"] !== "framing") {
          throw new Error("Agent media execution adjustment field is invalid");
        }
        return {
          field: adjustment["field"],
          requested: text(
            adjustment["requested"],
            "Agent media adjustment request",
          ),
          proposed: text(
            adjustment["proposed"],
            "Agent media adjustment proposal",
          ),
          reason: text(adjustment["reason"], "Agent media adjustment reason"),
        };
      }),
    };
  }
  if (source["disposition"] === "invalid") {
    const code = source["code"];
    if (
      code !== "variant-count-mismatch" &&
      code !== "duplicate-variant" &&
      code !== "subject-policy-invalid" &&
      code !== "reference-policy-invalid"
    ) {
      throw new Error("Agent media execution invalid code is invalid");
    }
    return {
      ...common,
      disposition: "invalid",
      code,
      message: text(source["message"], "Agent media execution failure"),
    };
  }
  if (
    source["disposition"] === "driver-execution-required" &&
    source["kind"] === "system-image"
  ) {
    const values = source["references"];
    if (!Array.isArray(values))
      throw new Error("Agent media execution references are invalid");
    const requestedOutputCount = integer(
      source["requestedOutputCount"],
      "Agent media execution requested output count",
    );
    const expectedOperationCount = integer(
      source["expectedOperationCount"],
      "Agent media execution expected operation count",
    );
    const variants = source["variants"];
    if (
      requestedOutputCount < 1 ||
      requestedOutputCount > 8 ||
      expectedOperationCount !== 1 ||
      !Array.isArray(variants) ||
      variants.length !== requestedOutputCount
    ) {
      throw new Error("Agent system-image execution cardinality is invalid");
    }
    return {
      ...common,
      disposition: "driver-execution-required",
      kind: "system-image",
      variants: variants.map((value, index) => {
        const variant = record(value, "Agent system-image variant");
        const ordinal = integer(
          variant["ordinal"],
          "Agent system-image variant ordinal",
        );
        if (ordinal !== index + 1) {
          throw new Error("Agent system-image variant order is invalid");
        }
        return {
          ordinal,
          prompt: text(variant["prompt"], "Agent system-image variant prompt"),
        };
      }),
      requestedOutputCount,
      expectedOperationCount: 1,
      references: values.map((value) => {
        const reference = record(value, "Agent media execution reference");
        const mimeType = reference["mimeType"];
        if (
          mimeType !== "image/png" &&
          mimeType !== "image/jpeg" &&
          mimeType !== "image/webp"
        ) {
          throw new Error(
            "Agent media execution reference MIME type is invalid",
          );
        }
        const width = reference["width"];
        const height = reference["height"];
        if (
          (width !== null &&
            (typeof width !== "number" || !Number.isSafeInteger(width))) ||
          (height !== null &&
            (typeof height !== "number" || !Number.isSafeInteger(height)))
        ) {
          throw new Error(
            "Agent media execution reference dimensions are invalid",
          );
        }
        return {
          artifactId: text(
            reference["artifactId"],
            "Agent media execution artifact ID",
          ),
          fileName: text(
            reference["fileName"],
            "Agent media execution reference file name",
          ),
          mimeType,
          byteLength: integer(
            reference["byteLength"],
            "Agent media execution reference byte length",
          ),
          contentHash: text(
            reference["contentHash"],
            "Agent media execution reference content hash",
          ),
          width,
          height,
        };
      }),
    };
  }
  throw new Error("Agent media execution disposition is invalid");
}

function characterAction(value: unknown): AgentToolActionEventProjection {
  const source = record(value, "Agent character action");
  if (
    source["kind"] !== "character-write" ||
    source["status"] !== "completed"
  ) {
    throw new Error("Agent character action is invalid");
  }
  return {
    actionId: text(source["actionId"], "Agent character action ID"),
    kind: "character-write",
    status: "completed",
    operationId: text(source["operationId"], "Agent character operation ID"),
  };
}

function characterResult(value: unknown): AgentCharacterResultProjection {
  const source = record(value, "Agent character result");
  const portrait = record(source["portrait"], "Agent character portrait");
  const portraitStatus = portrait["status"];
  const portraitUrl = portrait["url"];
  if (
    source["lifecycleStatus"] !== "draft" ||
    (portraitStatus !== "empty" && portraitStatus !== "selected") ||
    (portraitUrl !== null && typeof portraitUrl !== "string")
  ) {
    throw new Error("Agent character result is invalid");
  }
  return {
    characterId: text(source["characterId"], "Agent character ID"),
    displayName: text(source["displayName"], "Agent character display name"),
    brief: text(source["brief"], "Agent character brief"),
    creativeRole: text(source["creativeRole"], "Agent character creative role"),
    lifecycleStatus: "draft",
    version: integer(source["version"], "Agent character version"),
    path: text(source["path"], "Agent character path"),
    portrait: {
      status: portraitStatus,
      url: portraitUrl,
      alt: text(portrait["alt"], "Agent character portrait alternative"),
    },
  };
}

function attachment(value: unknown): AgentAttachmentProjection {
  const source = record(value, "Agent attachment");
  const mimeType = source["mimeType"];
  if (
    source["kind"] !== "image" ||
    (mimeType !== "image/png" &&
      mimeType !== "image/jpeg" &&
      mimeType !== "image/webp")
  ) {
    throw new Error("Agent attachment media type is invalid");
  }
  const role = source["role"];
  if (
    role !== null &&
    role !== "reference" &&
    role !== "edit-source" &&
    role !== "character" &&
    role !== "product"
  ) {
    throw new Error("Agent attachment role is invalid");
  }
  return {
    attachmentId: text(source["attachmentId"], "Agent attachment ID"),
    kind: "image",
    fileName: text(source["fileName"], "Agent attachment file name"),
    mimeType,
    byteLength: integer(source["byteLength"], "Agent attachment byte length"),
    contentHash: text(source["contentHash"], "Agent attachment content hash"),
    width: integer(source["width"], "Agent attachment width"),
    height: integer(source["height"], "Agent attachment height"),
    role,
  };
}

function messagePart(value: unknown): AgentMessagePart {
  const source = record(value, "Agent message part");
  if (source["type"] === "text") {
    return {
      type: "text",
      text: text(source["text"], "Agent message part text"),
    };
  }
  if (source["type"] === "attachment") {
    return { type: "attachment", attachment: attachment(source["attachment"]) };
  }
  throw new Error("Agent message part type is invalid");
}

function messageParts(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw new Error("Agent message parts are invalid");
  }
  return value.map(messagePart);
}

function inputCapabilities(value: unknown): readonly AgentInputCapability[] {
  if (
    !Array.isArray(value) ||
    value.some((capability) => capability !== "image-input")
  ) {
    throw new Error("Agent input capabilities are invalid");
  }
  return value as AgentInputCapability[];
}

function executionProfile(value: unknown): AgentExecutionProfile {
  if (value !== "auto" && value !== "fast" && value !== "thorough") {
    throw new Error("Agent execution profile is invalid");
  }
  return value;
}

function executionRouting(value: unknown): AgentExecutionRoutingProjection {
  const source = record(value, "Agent execution routing");
  const reasoningDepth = source["reasoningDepth"];
  const minimumCapability = source["minimumCapability"];
  const reason = source["reason"];
  if (
    source["policyVersion"] !== "starlight.agent-routing.v1" ||
    (reasoningDepth !== "adapter-default" &&
      reasoningDepth !== "low" &&
      reasoningDepth !== "high") ||
    (minimumCapability !== "text" && minimumCapability !== "image") ||
    (reason !== "automatic-capable-conversation" &&
      reason !== "automatic-with-image-input" &&
      reason !== "legacy-explicit-image-capability")
  ) {
    throw new Error("Agent execution routing is invalid");
  }
  return {
    policyVersion: "starlight.agent-routing.v1",
    executionProfile: executionProfile(source["executionProfile"]),
    reasoningDepth,
    minimumCapability,
    requiredInputCapabilities: inputCapabilities(
      source["requiredInputCapabilities"],
    ),
    reason,
  };
}

function behaviorProfileVersion(value: unknown) {
  return requireCreativeDriverBehaviorProfile(value).profileVersion;
}

function userMessage(value: unknown): AgentDriverTurn["userMessage"] {
  const source = record(value, "Agent turn user message");
  if (source["role"] !== "user")
    throw new Error("Agent turn user message role is invalid");
  return {
    messageId: text(source["messageId"], "Agent message ID"),
    sequence: integer(source["sequence"], "Agent message sequence"),
    role: "user",
    parts: messageParts(source["parts"]),
    text: string(source["text"], "Agent message text"),
    createdAt: integer(source["createdAt"], "Agent message creation time"),
  };
}

function turn(value: unknown): AgentDriverTurn {
  const source = record(value, "Agent turn");
  const capability = source["capability"];
  if (capability !== "text" && capability !== "image") {
    throw new Error("Agent turn capability is invalid");
  }
  return {
    workspaceId: text(source["workspaceId"], "Agent turn workspace ID"),
    sessionId: text(source["sessionId"], "Agent turn session ID"),
    sessionTitle: text(source["sessionTitle"], "Agent turn session title"),
    turnId: text(source["turnId"], "Agent turn ID"),
    capability,
    routing: executionRouting(source["routing"]),
    behaviorProfileVersion: behaviorProfileVersion(
      source["behaviorProfileVersion"],
    ),
    requiredInputCapabilities: inputCapabilities(
      source["requiredInputCapabilities"],
    ),
    userMessage: userMessage(source["userMessage"]),
    queuedAt: integer(source["queuedAt"], "Agent turn queue time"),
    recoveryCount: integer(
      source["recoveryCount"],
      "Agent turn recovery count",
    ),
  };
}

function claimedTurn(value: unknown): AgentDriverClaimedTurn {
  const source = record(value, "Claimed Agent turn");
  return {
    ...turn(value),
    workingSet: requireAgentWorkingSetProjection(source["workingSet"]),
  };
}

function lease(value: unknown): AgentDriverLease {
  const source = record(value, "Agent turn lease");
  return {
    leaseId: text(source["leaseId"], "Agent lease ID"),
    fencingToken: integer(source["fencingToken"], "Agent lease fencing token"),
    expiresAt: integer(source["expiresAt"], "Agent lease expiry"),
  };
}

function claim(value: unknown): AgentDriverClaim | null {
  if (value === null) return null;
  const source = record(value, "Agent turn claim");
  if (typeof source["replayed"] !== "boolean") {
    throw new Error("Agent turn claim replay state is invalid");
  }
  return {
    turn: claimedTurn(source["turn"]),
    lease: lease(source["lease"]),
    nextEventSequence: integer(
      source["nextEventSequence"],
      "Agent next event sequence",
    ),
    replayed: source["replayed"],
  };
}

function message(
  value: unknown,
): AgentDriverSessionContext["messages"][number] {
  const source = record(value, "Agent session message");
  const role = source["role"];
  if (role !== "user" && role !== "assistant") {
    throw new Error("Agent session message role is invalid");
  }
  return {
    messageId: text(source["messageId"], "Agent session message ID"),
    sequence: integer(source["sequence"], "Agent session message sequence"),
    role,
    parts: messageParts(source["parts"]),
    text: string(source["text"], "Agent session message text"),
    createdAt: integer(
      source["createdAt"],
      "Agent session message creation time",
    ),
  };
}

export function parseAgentDriverSessionContext(
  value: unknown,
): AgentDriverSessionContext {
  const source = record(value, "Agent session context");
  const session = record(source["session"], "Agent session");
  const activeTurn = record(source["activeTurn"], "Agent active turn");
  const messages = source["messages"];
  if (!Array.isArray(messages))
    throw new Error("Agent session messages are invalid");
  const capability = activeTurn["capability"];
  if (capability !== "text" && capability !== "image") {
    throw new Error("Agent active turn capability is invalid");
  }
  const protocolVersion = source["driverProtocolVersion"];
  const rawInstructions = source["driverInstructions"];
  if ((protocolVersion === undefined) !== (rawInstructions === undefined)) {
    throw new Error("Agent driver instruction contract is incomplete");
  }
  const driverInstructions =
    protocolVersion === undefined
      ? {}
      : (() => {
          if (protocolVersion !== STARLIGHT_DRIVER_PROTOCOL_VERSION) {
            throw new Error("Agent driver protocol version is unsupported");
          }
          const instructions = record(
            rawInstructions,
            "Agent driver instructions",
          );
          if (
            instructions["schemaVersion"] !==
            AGENT_DRIVER_INSTRUCTIONS_SCHEMA_VERSION
          ) {
            throw new Error("Agent driver instruction schema is unsupported");
          }
          const tools = instructions["tools"];
          if (!Array.isArray(tools))
            throw new Error("Agent driver tool definitions are invalid");
          return {
            driverProtocolVersion: STARLIGHT_DRIVER_PROTOCOL_VERSION,
            driverInstructions: {
              schemaVersion: AGENT_DRIVER_INSTRUCTIONS_SCHEMA_VERSION,
              text: text(instructions["text"], "Agent driver instruction text"),
              tools: tools.map((value) => {
                const tool = record(value, "Agent driver tool definition");
                const capability = tool["capability"];
                if (
                  capability !== "text" &&
                  capability !== "image" &&
                  capability !== "media-video" &&
                  capability !== "media-voice-design" &&
                  capability !== "media-speech"
                ) {
                  throw new Error("Agent driver tool capability is invalid");
                }
                const name = tool["name"];
                if (!isAgentDriverToolName(name)) {
                  throw new Error("Agent driver tool name is unsupported");
                }
                const inputSchema = record(
                  tool["inputSchema"],
                  "Agent driver tool input schema",
                );
                assertSupportedDynamicToolSchema(inputSchema);
                return {
                  schemaVersion: text(
                    tool["schemaVersion"],
                    "Agent driver tool schema version",
                  ),
                  name,
                  capability,
                  description: text(
                    tool["description"],
                    "Agent driver tool description",
                  ),
                  inputSchema,
                };
              }),
            },
          };
        })();
  return {
    behaviorProfileVersion: behaviorProfileVersion(
      source["behaviorProfileVersion"],
    ),
    ...driverInstructions,
    workingSet: requireAgentWorkingSetProjection(source["workingSet"]),
    session: {
      sessionId: text(session["sessionId"], "Agent session ID"),
      title: text(session["title"], "Agent session title"),
    },
    messages: messages.map(message),
    activeTurn: {
      turnId: text(activeTurn["turnId"], "Agent active turn ID"),
      status: text(activeTurn["status"], "Agent active turn status"),
      eventSequence: integer(
        activeTurn["eventSequence"],
        "Agent active turn event sequence",
      ),
      capability,
      routing: executionRouting(activeTurn["routing"]),
      requiredInputCapabilities: inputCapabilities(
        activeTurn["requiredInputCapabilities"],
      ),
    },
  };
}

function intervention(value: unknown): AgentDriverAcceptedIntervention {
  const source = record(value, "Agent intervention");
  const capability = source["capability"];
  const fallbackPolicy = source["fallbackPolicy"];
  const references = source["references"];
  if (capability !== "text" && capability !== "image") {
    throw new Error("Agent intervention capability is invalid");
  }
  if (fallbackPolicy !== "queue" && fallbackPolicy !== "reject") {
    throw new Error("Agent intervention fallback policy is invalid");
  }
  if (!Array.isArray(references))
    throw new Error("Agent intervention references are invalid");
  return {
    interventionId: text(source["interventionId"], "Agent intervention ID"),
    expectedTurnId: text(
      source["expectedTurnId"],
      "Agent intervention turn ID",
    ),
    sequence: integer(source["sequence"], "Agent intervention sequence"),
    version: integer(source["version"], "Agent intervention version"),
    parts: messageParts(source["parts"]),
    text: string(source["text"], "Agent intervention text"),
    capability,
    executionProfile: executionProfile(source["executionProfile"]),
    requiredInputCapabilities: inputCapabilities(
      source["requiredInputCapabilities"],
    ),
    references: references.map((value) => {
      const reference = record(value, "Agent intervention reference");
      const kind = reference["kind"];
      if (
        kind !== "character" &&
        kind !== "production" &&
        kind !== "storyboard" &&
        kind !== "operation" &&
        kind !== "artifact" &&
        kind !== "decision"
      ) {
        throw new Error("Agent intervention reference kind is invalid");
      }
      const path = reference["path"];
      if (path !== null && typeof path !== "string") {
        throw new Error("Agent intervention reference path is invalid");
      }
      return {
        kind,
        resourceId: text(
          reference["resourceId"],
          "Agent intervention reference ID",
        ),
        label: text(reference["label"], "Agent intervention reference label"),
        path,
      };
    }),
    fallbackPolicy,
  };
}

function transitionResult(
  value: Readonly<Record<string, unknown>>,
  expectedStatus: "completed" | "failed" | "interrupted",
) {
  const transitionTurn = record(value["turn"], "Agent turn transition");
  if (value["schemaVersion"] !== "starlight.agent-turn-transition.v1") {
    throw new AgentDriverApiError(
      "The Starlight driver API returned an unrecognized turn transition response",
      "outcome-ambiguous",
      200,
    );
  }
  if (
    transitionTurn["status"] !== expectedStatus ||
    typeof value["replayed"] !== "boolean"
  ) {
    throw new AgentDriverApiError(
      `Starlight did not confirm the turn reached ${expectedStatus} state`,
      "outcome-ambiguous",
      200,
    );
  }
  return value;
}

function expectedResourceFor(state: StoredAgentBridgeState) {
  return new URL("/mcp", `${state.webUrl}/`).toString();
}

export class AgentDriverApiClient {
  private readonly store: AgentCredentialStore;
  private readonly fetcher: Fetch;
  private readonly now: () => number;
  private readonly requestTimeoutMs: number;

  constructor(dependencies: AgentDriverApiClientDependencies = {}) {
    this.store = dependencies.store ?? createDefaultAgentCredentialStore();
    this.fetcher = dependencies.fetch ?? fetch;
    this.now = dependencies.now ?? Date.now;
    this.requestTimeoutMs = dependencies.requestTimeoutMs ?? 15_000;
  }

  private async credential() {
    const state = await this.store.read();
    if (state?.credential === undefined) {
      throw new AgentDriverApiError(
        "Starlight pairing is required; run starlight auth login",
        "authentication-required",
        null,
      );
    }
    if (state.credential.expiresAt <= this.now()) {
      throw new AgentDriverApiError(
        "The Starlight pairing expired; pair this device again",
        "credential-expired",
        null,
      );
    }
    if (
      !state.credential.scopes.includes("session:read") ||
      !state.credential.scopes.includes("turn:claim")
    ) {
      throw new AgentDriverApiError(
        "This pairing cannot run text turns; pair the device again to grant the current driver scopes",
        "driver-capability-unavailable",
        null,
      );
    }
    const expectedResource = expectedResourceFor(state);
    const resource = state.credential.resource;
    if (resource === undefined) {
      throw new AgentDriverApiError(
        "This older pairing has no explicit resource binding; pair the device again",
        "driver-capability-unavailable",
        null,
      );
    }
    if (resource !== expectedResource) {
      throw new AgentDriverApiError(
        "The stored Starlight pairing is bound to another resource",
        "resource-mismatch",
        null,
      );
    }
    return { state, credential: { ...state.credential, resource } };
  }

  private async request(
    path: string,
    init: { readonly method?: "GET" | "POST"; readonly body?: unknown } = {},
  ) {
    const { state, credential } = await this.credential();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(`${state.apiUrl}${path}`, {
        method: init.method ?? "GET",
        headers: {
          authorization: `Bearer ${credential.token}`,
          "x-starlight-resource": credential.resource,
          ...(init.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: controller.signal,
      });
    } catch (error) {
      const mutation = init.method === "POST";
      throw new AgentDriverApiError(
        mutation
          ? "The Starlight driver request did not reach a definitive outcome"
          : "The Starlight driver could not read the current durable state",
        mutation ? "outcome-ambiguous" : "request-rejected",
        null,
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
    const body = (await response.json().catch(() => null)) as unknown;
    if (response.ok) {
      if (!isRecord(body)) {
        throw new AgentDriverApiError(
          "The Starlight driver API returned an invalid success response",
          init.method === "POST" ? "outcome-ambiguous" : "request-rejected",
          response.status,
        );
      }
      return body;
    }
    if (response.status === 401) {
      throw new AgentDriverApiError(
        "The Starlight credential is invalid, expired, or bound to another resource",
        "resource-mismatch",
        response.status,
      );
    }
    if (response.status === 403) {
      const serverMessage =
        isRecord(body) &&
        body["schemaVersion"] === "starlight.agent-authorization-error.v1" &&
        typeof body["message"] === "string" &&
        body["message"].length > 0 &&
        body["message"].length <= 300
          ? body["message"]
          : null;
      throw new AgentDriverApiError(
        serverMessage ??
          "The Starlight credential does not grant access to the requested tool",
        "driver-capability-unavailable",
        response.status,
      );
    }
    if (response.status === 409) {
      throw new AgentDriverApiError(
        "The durable turn or lease changed; this driver no longer owns it",
        "lease-lost",
        response.status,
      );
    }
    if (
      response.status === 422 &&
      isRecord(body) &&
      body["schemaVersion"] === "starlight.agent-tool-rejection.v1" &&
      body["code"] === "invalid-tool-arguments" &&
      typeof body["message"] === "string" &&
      body["message"].length > 0 &&
      body["message"].length <= 300
    ) {
      throw new AgentDriverApiError(
        body["message"],
        "request-rejected",
        response.status,
        {
          nextEventSequence: integer(
            body["nextEventSequence"],
            "Agent rejection next event sequence",
          ),
        },
      );
    }
    throw new AgentDriverApiError(
      `The Starlight driver request was rejected with HTTP ${String(response.status)}`,
      "request-rejected",
      response.status,
    );
  }

  async getCredentialContext() {
    const body = await this.request("/agent/v1/auth/context");
    const workspace = record(
      body["workspace"],
      "Starlight credential workspace",
    );
    const resource = text(body["resource"], "Starlight credential resource");
    if (resource !== expectedResourceFor((await this.credential()).state)) {
      throw new AgentDriverApiError(
        "The Starlight credential context belongs to another resource",
        "resource-mismatch",
        null,
      );
    }
    const scopes = body["scopes"];
    if (
      !Array.isArray(scopes) ||
      scopes.some((scope) => typeof scope !== "string")
    ) {
      throw new Error("Starlight credential scopes are invalid");
    }
    return {
      credentialId: text(body["credentialId"], "Starlight credential ID"),
      clientLabel: text(body["clientLabel"], "Starlight client label"),
      resource,
      scopes: scopes as string[],
      expiresAt: integer(body["expiresAt"], "Starlight credential expiry"),
      workspace: {
        workspaceId: text(workspace["workspaceId"], "Starlight workspace ID"),
        name: text(workspace["name"], "Starlight workspace name"),
      },
    };
  }

  async heartbeatPresence(input: {
    readonly ttlMs: number;
    readonly runtimeVersion: string;
    readonly capabilities: readonly AgentDriverCapability[];
    readonly executionProfiles: readonly AgentExecutionProfile[];
  }) {
    return await this.request("/agent/v1/driver/heartbeat", {
      method: "POST",
      body: input,
    });
  }

  async reportOffline() {
    return await this.request("/agent/v1/driver/offline", {
      method: "POST",
      body: {},
    });
  }

  async listPending(limit = 20) {
    const body = await this.request(
      `/agent/v1/turns/pending?limit=${String(limit)}`,
    );
    const turns = body["turns"];
    if (!Array.isArray(turns))
      throw new Error("Pending Starlight turns are invalid");
    return turns.map(turn);
  }

  async claimTurn(input: {
    readonly targetTurnId: string;
    readonly idempotencyKey: string;
    readonly leaseDurationMs: number;
  }) {
    const body = await this.request("/agent/v1/turns/claim", {
      method: "POST",
      body: input,
    });
    return claim(body["claim"]);
  }

  async getSessionContext(
    leaseInput: Pick<AgentDriverLease, "leaseId" | "fencingToken">,
    instructionInput?: {
      readonly systemImageGeneration: boolean;
    },
  ) {
    const query = new URLSearchParams({
      leaseId: leaseInput.leaseId,
      fencingToken: String(leaseInput.fencingToken),
    });
    if (instructionInput !== undefined) {
      query.set("driverProtocolVersion", STARLIGHT_DRIVER_PROTOCOL_VERSION);
      query.set(
        "systemImageGeneration",
        instructionInput.systemImageGeneration ? "1" : "0",
      );
    }
    const context = parseAgentDriverSessionContext(
      await this.request(`/agent/v1/turns/context?${query.toString()}`),
    );
    if (
      instructionInput !== undefined &&
      (context.driverProtocolVersion !== STARLIGHT_DRIVER_PROTOCOL_VERSION ||
        context.driverInstructions === undefined)
    ) {
      throw new AgentDriverApiError(
        "The Starlight server does not provide the required driver protocol",
        "request-rejected",
        409,
      );
    }
    return context;
  }

  async downloadAttachment(input: {
    readonly leaseId: string;
    readonly fencingToken: number;
    readonly attachment: AgentAttachmentProjection;
  }) {
    const { state, credential } = await this.credential();
    const query = new URLSearchParams({
      leaseId: input.leaseId,
      fencingToken: String(input.fencingToken),
    });
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(this.requestTimeoutMs, 60_000),
    );
    let response: Response;
    try {
      response = await this.fetcher(
        `${state.apiUrl}/agent/v1/turns/attachments/${encodeURIComponent(input.attachment.attachmentId)}?${query.toString()}`,
        {
          headers: {
            authorization: `Bearer ${credential.token}`,
            "x-starlight-resource": credential.resource,
          },
          signal: controller.signal,
        },
      );
    } catch (error) {
      throw new AgentDriverApiError(
        "The Starlight driver could not read the durable attachment bytes",
        "request-rejected",
        null,
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      throw new AgentDriverApiError(
        `The Starlight attachment request was rejected with HTTP ${String(response.status)}`,
        response.status === 409 ? "lease-lost" : "request-rejected",
        response.status,
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const contentHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const mediaType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.toLowerCase();
    if (
      bytes.byteLength !== input.attachment.byteLength ||
      contentHash !== input.attachment.contentHash ||
      mediaType !== input.attachment.mimeType
    ) {
      throw new AgentDriverApiError(
        "The delivered attachment bytes do not match their durable evidence",
        "request-rejected",
        response.status,
      );
    }
    return bytes;
  }

  async listAcceptedInterventions(
    leaseInput: Pick<AgentDriverLease, "leaseId" | "fencingToken">,
  ) {
    const query = new URLSearchParams({
      leaseId: leaseInput.leaseId,
      fencingToken: String(leaseInput.fencingToken),
    });
    const body = await this.request(
      `/agent/v1/turns/interventions?${query.toString()}`,
    );
    if (body["schemaVersion"] !== "starlight.agent-intervention-delivery.v1") {
      throw new Error("Agent intervention delivery schema is invalid");
    }
    const values = body["interventions"];
    if (!Array.isArray(values))
      throw new Error("Agent intervention delivery is invalid");
    return values.map(intervention);
  }

  async resolveIntervention(input: {
    readonly leaseId: string;
    readonly fencingToken: number;
    readonly interventionId: string;
    readonly expectedVersion: number;
    readonly disposition: "applied" | "unsupported" | "cannot-apply";
    readonly idempotencyKey: string;
  }) {
    const body = await this.request("/agent/v1/turns/interventions/resolve", {
      method: "POST",
      body: input,
    });
    const outcome = body["outcome"];
    if (
      body["schemaVersion"] !== "starlight.agent-intervention-resolution.v1" ||
      (outcome !== "applied" &&
        outcome !== "rejected" &&
        outcome !== "converted-to-queue") ||
      typeof body["replayed"] !== "boolean"
    ) {
      throw new AgentDriverApiError(
        "Starlight did not confirm the intervention resolution",
        "outcome-ambiguous",
        200,
      );
    }
    return {
      outcome,
      replayed: body["replayed"],
    };
  }

  async heartbeatTurn(input: {
    readonly leaseId: string;
    readonly fencingToken: number;
    readonly leaseDurationMs: number;
  }) {
    const body = await this.request("/agent/v1/turns/heartbeat", {
      method: "POST",
      body: input,
    });
    return { expiresAt: integer(body["expiresAt"], "Agent lease expiry") };
  }

  async appendProgress(input: {
    readonly leaseId: string;
    readonly fencingToken: number;
    readonly expectedSequence: number;
    readonly stage: string;
    readonly message: string;
    readonly idempotencyKey: string;
  }) {
    const body = await this.request("/agent/v1/turns/progress", {
      method: "POST",
      body: { ...input, references: [] },
    });
    return {
      nextEventSequence: integer(
        body["nextEventSequence"],
        "Agent next event sequence",
      ),
      replayed: body["replayed"] === true,
    };
  }

  async completeTurn(input: {
    readonly leaseId: string;
    readonly fencingToken: number;
    readonly expectedSequence: number;
    readonly text: string;
    readonly blocks?: readonly AgentResponseBlockInput[];
    readonly idempotencyKey: string;
  }) {
    return transitionResult(
      await this.request("/agent/v1/turns/complete", {
        method: "POST",
        body: { ...input, references: [] },
      }),
      "completed",
    );
  }

  async beginImageOperation(input: {
    readonly leaseId: string;
    readonly fencingToken: number;
    readonly model: string;
    readonly tool: string;
    readonly sourceRuntimeVersion: string;
    readonly driverRuntimeVersion: string;
  }) {
    const body = await this.request("/agent/v1/turns/image/begin", {
      method: "POST",
      body: input,
    });
    if (
      body["schemaVersion"] !== "starlight.agent-image-operation.v1" ||
      typeof body["dispatchAllowed"] !== "boolean"
    ) {
      throw new AgentDriverApiError(
        "Starlight did not confirm the image dispatch fence",
        "outcome-ambiguous",
        200,
      );
    }
    return {
      operationId: text(body["operationId"], "Agent image operation ID"),
      status: text(body["status"], "Agent image operation status"),
      dispatchAllowed: body["dispatchAllowed"],
      dispatchCount: integer(
        body["dispatchCount"],
        "Agent image dispatch count",
      ),
    };
  }

  async startImageTool(input: {
    readonly leaseId: string;
    readonly fencingToken: number;
    readonly expectedSequence: number;
    readonly model: string;
    readonly tool: string;
    readonly sourceRuntimeVersion: string;
    readonly driverRuntimeVersion: string;
    readonly idempotencyKey: string;
    readonly proposalId?: string;
    readonly proposalOrdinal?: number;
    readonly parentOperationId?: string;
  }) {
    const body = await this.request("/agent/v1/turns/tools/image/start", {
      method: "POST",
      body: input,
    });
    if (
      body["schemaVersion"] !== "starlight.agent-tool-start.v1" ||
      typeof body["dispatchAllowed"] !== "boolean" ||
      typeof body["replayed"] !== "boolean"
    ) {
      throw new AgentDriverApiError(
        "Starlight did not confirm the image tool start",
        "outcome-ambiguous",
        200,
      );
    }
    return {
      actionId: text(body["actionId"], "Agent action ID"),
      operationId: text(body["operationId"], "Agent image operation ID"),
      status: text(body["status"], "Agent image operation status"),
      dispatchAllowed: body["dispatchAllowed"],
      dispatchCount: integer(
        body["dispatchCount"],
        "Agent image dispatch count",
      ),
      nextEventSequence: integer(
        body["nextEventSequence"],
        "Agent next event sequence",
      ),
      replayed: body["replayed"],
    };
  }

  async proposeMediaExecution(input: {
    readonly leaseId: string;
    readonly fencingToken: number;
    readonly expectedSequence: number;
    readonly callId: string;
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly sourceRuntimeVersion: string;
    readonly driverRuntimeVersion: string;
  }) {
    return parseAgentMediaExecutionResult(
      await this.request("/agent/v1/turns/tools/media/propose", {
        method: "POST",
        body: input,
      }),
    );
  }

  async downloadMediaExecutionReference(input: {
    readonly leaseId: string;
    readonly fencingToken: number;
    readonly proposalId: string;
    readonly reference: Extract<
      AgentMediaExecutionResult,
      { readonly disposition: "driver-execution-required" }
    >["references"][number];
  }) {
    const { state, credential } = await this.credential();
    const query = new URLSearchParams({
      leaseId: input.leaseId,
      fencingToken: String(input.fencingToken),
      proposalId: input.proposalId,
    });
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(this.requestTimeoutMs, 60_000),
    );
    let response: Response;
    try {
      response = await this.fetcher(
        `${state.apiUrl}/agent/v1/turns/media-execution/references/${encodeURIComponent(input.reference.artifactId)}?${query.toString()}`,
        {
          headers: {
            authorization: `Bearer ${credential.token}`,
            "x-starlight-resource": credential.resource,
          },
          signal: controller.signal,
        },
      );
    } catch (error) {
      throw new AgentDriverApiError(
        "The Starlight driver could not read the resolved reference bytes",
        "request-rejected",
        null,
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      throw new AgentDriverApiError(
        `The Starlight reference request was rejected with HTTP ${String(response.status)}`,
        response.status === 409 ? "lease-lost" : "request-rejected",
        response.status,
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const contentHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const mediaType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.toLowerCase();
    if (
      bytes.byteLength !== input.reference.byteLength ||
      contentHash !== input.reference.contentHash ||
      mediaType !== input.reference.mimeType
    ) {
      throw new AgentDriverApiError(
        "The delivered reference bytes do not match their durable evidence",
        "request-rejected",
        response.status,
      );
    }
    return bytes;
  }

  async startMediaTool(input: {
    readonly leaseId: string;
    readonly fencingToken: number;
    readonly expectedSequence: number;
    readonly toolName: AgentMediaToolName;
    readonly callId: string;
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly sourceRuntimeVersion: string;
    readonly driverRuntimeVersion: string;
  }) {
    const body = await this.request("/agent/v1/turns/tools/media/start", {
      method: "POST",
      body: input,
    });
    if (
      body["schemaVersion"] !== "starlight.agent-media-tool-start.v1" ||
      typeof body["replayed"] !== "boolean"
    ) {
      throw new AgentDriverApiError(
        "Starlight did not confirm the media tool start",
        "outcome-ambiguous",
        200,
      );
    }
    return {
      action: mediaAction(body["action"]),
      title: text(body["title"], "Agent media action title"),
      operationStatus: text(
        body["operationStatus"],
        "Agent media operation status",
      ),
      nextEventSequence: integer(
        body["nextEventSequence"],
        "Agent next event sequence",
      ),
      replayed: body["replayed"],
    };
  }

  async rejectToolCall(input: {
    readonly leaseId: string;
    readonly fencingToken: number;
    readonly expectedSequence: number;
    readonly toolName: AgentDriverToolName;
    readonly callId: string;
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly sourceRuntimeVersion: string;
    readonly driverRuntimeVersion: string;
  }) {
    const body = await this.request("/agent/v1/turns/tools/reject", {
      method: "POST",
      body: input,
    });
    if (
      body["schemaVersion"] !== "starlight.agent-tool-rejection.v1" ||
      body["code"] !== "invalid-tool-arguments" ||
      body["toolName"] !== input.toolName ||
      typeof body["field"] !== "string" ||
      body["field"].length < 1 ||
      body["field"].length > 160 ||
      typeof body["message"] !== "string" ||
      body["message"].length < 1 ||
      body["message"].length > 300 ||
      typeof body["replayed"] !== "boolean"
    ) {
      throw new AgentDriverApiError(
        "Starlight did not confirm the tool input rejection",
        "outcome-ambiguous",
        200,
      );
    }
    return {
      schemaVersion: "starlight.agent-tool-rejection.v1" as const,
      code: "invalid-tool-arguments" as const,
      toolName: input.toolName,
      field: body["field"],
      message: body["message"],
      nextEventSequence: integer(
        body["nextEventSequence"],
        "Agent next event sequence",
      ),
      replayed: body["replayed"],
    };
  }

  async startCharacterTool(input: {
    readonly leaseId: string;
    readonly fencingToken: number;
    readonly expectedSequence: number;
    readonly toolName: AgentCharacterToolName;
    readonly callId: string;
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly sourceRuntimeVersion: string;
    readonly driverRuntimeVersion: string;
  }) {
    const body = await this.request("/agent/v1/turns/tools/character/start", {
      method: "POST",
      body: input,
    });
    const change = body["change"];
    if (
      body["schemaVersion"] !== "starlight.agent-character-tool-start.v1" ||
      typeof body["replayed"] !== "boolean" ||
      (change !== "saved" && change !== "revised")
    ) {
      throw new AgentDriverApiError(
        "Starlight did not confirm the character tool write",
        "outcome-ambiguous",
        200,
      );
    }
    return {
      action: characterAction(body["action"]),
      change,
      character: characterResult(body["character"]),
      nextEventSequence: integer(
        body["nextEventSequence"],
        "Agent next event sequence",
      ),
      replayed: body["replayed"],
    };
  }

  async resolveSessionMedia(input: {
    readonly leaseId: string;
    readonly fencingToken: number;
    readonly expectedSequence: number;
    readonly toolName: typeof AGENT_SESSION_MEDIA_TOOL_NAME;
    readonly callId: string;
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly sourceRuntimeVersion: string;
    readonly driverRuntimeVersion: string;
  }): Promise<{
    readonly resolution: AgentSessionMediaResolution;
    readonly selectionPersisted: boolean;
    readonly nextEventSequence: number;
    readonly replayed: boolean;
  }> {
    const body = await this.request(
      "/agent/v1/turns/tools/session-media/resolve",
      {
        method: "POST",
        body: input,
      },
    );
    if (
      body["schemaVersion"] !==
        "starlight.agent-session-media-tool-result.v1" ||
      typeof body["selectionPersisted"] !== "boolean" ||
      typeof body["replayed"] !== "boolean"
    ) {
      throw new AgentDriverApiError(
        "Starlight did not confirm the session-media resolution",
        "outcome-ambiguous",
        200,
      );
    }
    return {
      resolution: requireAgentSessionMediaResolution(body["resolution"]),
      selectionPersisted: body["selectionPersisted"],
      nextEventSequence: integer(
        body["nextEventSequence"],
        "Agent next event sequence",
      ),
      replayed: body["replayed"],
    };
  }

  async appendImageToolProgress(input: {
    readonly leaseId: string;
    readonly fencingToken: number;
    readonly expectedSequence: number;
    readonly operationId: string;
    readonly stage: string;
    readonly message: string;
    readonly idempotencyKey: string;
  }) {
    const body = await this.request("/agent/v1/turns/tools/image/progress", {
      method: "POST",
      body: input,
    });
    if (body["schemaVersion"] !== "starlight.agent-tool-progress.v1") {
      throw new AgentDriverApiError(
        "Starlight did not confirm the image tool progress",
        "outcome-ambiguous",
        200,
      );
    }
    return {
      nextEventSequence: integer(
        body["nextEventSequence"],
        "Agent next event sequence",
      ),
      replayed: body["replayed"] === true,
    };
  }

  async failImageTool(input: {
    readonly leaseId: string;
    readonly fencingToken: number;
    readonly expectedSequence: number;
    readonly operationId: string;
    readonly code: string;
    readonly message: string;
    readonly ambiguous: boolean;
    readonly idempotencyKey: string;
  }) {
    const body = await this.request("/agent/v1/turns/tools/image/fail", {
      method: "POST",
      body: input,
    });
    if (
      body["schemaVersion"] !== "starlight.agent-tool-failure.v1" ||
      (body["status"] !== "failed" && body["status"] !== "ambiguous")
    ) {
      throw new AgentDriverApiError(
        "Starlight did not confirm the image tool failure",
        "outcome-ambiguous",
        200,
      );
    }
    return {
      status: body["status"],
      nextEventSequence: integer(
        body["nextEventSequence"],
        "Agent next event sequence",
      ),
      replayed: body["replayed"] === true,
    };
  }

  async prepareImageUpload(input: {
    readonly leaseId: string;
    readonly fencingToken: number;
    readonly operationId: string;
    readonly contentHash: string;
    readonly mimeType: string;
    readonly byteLength: number;
    readonly width: number;
    readonly height: number;
    readonly sourceItemId: string;
    readonly revisedPrompt?: string;
  }) {
    const body = await this.request("/agent/v1/turns/image/prepare-upload", {
      method: "POST",
      body: input,
    });
    if (
      body["schemaVersion"] !== "starlight.agent-image-upload.v1" ||
      body["status"] !== "captured" ||
      body["replayed"] !== false
    ) {
      throw new AgentDriverApiError(
        "Starlight did not issue one definitive image archive target",
        "outcome-ambiguous",
        200,
      );
    }
    return { uploadUrl: text(body["uploadUrl"], "Agent image upload URL") };
  }

  async uploadImage(input: {
    readonly uploadUrl: string;
    readonly bytes: Uint8Array;
    readonly mimeType: string;
  }) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(this.requestTimeoutMs, 60_000),
    );
    let response: Response;
    try {
      response = await this.fetcher(input.uploadUrl, {
        method: "POST",
        headers: { "content-type": input.mimeType },
        body: new Blob([Uint8Array.from(input.bytes)], {
          type: input.mimeType,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new AgentDriverApiError(
        "The validated image upload did not reach a definitive outcome",
        "outcome-ambiguous",
        null,
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      throw new AgentDriverApiError(
        `The image archive rejected the upload with HTTP ${String(response.status)}`,
        "request-rejected",
        response.status,
      );
    }
    if (!isRecord(body)) {
      throw new AgentDriverApiError(
        "The image upload outcome is ambiguous because no storage receipt was returned",
        "outcome-ambiguous",
        response.status,
      );
    }
    return { storageId: text(body["storageId"], "Agent image storage ID") };
  }

  async archiveImage(input: {
    readonly leaseId: string;
    readonly fencingToken: number;
    readonly expectedSequence: number;
    readonly operationId: string;
    readonly storageId?: string;
    readonly items?: readonly {
      readonly sourceItemId: string;
      readonly storageId: string;
    }[];
    readonly attemptCount?: number;
    readonly text: string;
  }) {
    const { state, credential } = await this.credential();
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(this.requestTimeoutMs, 90_000),
    );
    let response: Response;
    try {
      response = await this.fetcher(
        `${state.webUrl}/api/agent-driver/image-archive`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${credential.token}`,
            "content-type": "application/json",
            "x-starlight-resource": credential.resource,
          },
          body: JSON.stringify(input),
          signal: controller.signal,
        },
      );
    } catch (error) {
      throw new AgentDriverApiError(
        "The Starlight image archive request did not reach a definitive outcome",
        "outcome-ambiguous",
        null,
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
    const body = (await response.json().catch(() => null)) as unknown;
    if (response.ok) {
      if (
        !isRecord(body) ||
        body["schemaVersion"] !== "starlight.agent-image-completion.v1" ||
        body["status"] !== "archived" ||
        typeof body["replayed"] !== "boolean"
      ) {
        throw new AgentDriverApiError(
          "Starlight did not confirm the image artifact and turn completion",
          "outcome-ambiguous",
          response.status,
        );
      }
      return {
        artifactId: text(body["artifactId"], "Agent image artifact ID"),
        artifactIds: Array.isArray(body["artifactIds"])
          ? body["artifactIds"].map((value) =>
              text(value, "Agent image artifact ID"),
            )
          : [text(body["artifactId"], "Agent image artifact ID")],
        replayed: body["replayed"],
      };
    }
    const code = isRecord(body) ? body["code"] : null;
    if (response.status === 401 || code === "resource-mismatch") {
      throw new AgentDriverApiError(
        "The Starlight credential is invalid, expired, or bound to another resource",
        "resource-mismatch",
        response.status,
      );
    }
    if (response.status === 403 || code === "driver-capability-unavailable") {
      throw new AgentDriverApiError(
        "The Starlight credential does not grant image-driver access",
        "driver-capability-unavailable",
        response.status,
      );
    }
    if (response.status === 409 || code === "lease-lost") {
      throw new AgentDriverApiError(
        "The durable turn or lease changed; this driver no longer owns it",
        "lease-lost",
        response.status,
      );
    }
    const ambiguous =
      code === "outcome-ambiguous" ||
      (response.status >= 500 && code !== "request-rejected");
    throw new AgentDriverApiError(
      ambiguous
        ? "The Starlight image archive outcome is ambiguous"
        : `The Starlight image archive was rejected with HTTP ${String(response.status)}`,
      ambiguous ? "outcome-ambiguous" : "request-rejected",
      response.status,
    );
  }

  async archiveImageItem(input: {
    readonly leaseId: string;
    readonly fencingToken: number;
    readonly expectedSequence: number;
    readonly operationId: string;
    readonly sourceItemId: string;
    readonly storageId: string;
    readonly itemNumber: number;
    readonly idempotencyKey: string;
  }) {
    const { state, credential } = await this.credential();
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(this.requestTimeoutMs, 90_000),
    );
    let response: Response;
    try {
      response = await this.fetcher(
        `${state.webUrl}/api/agent-driver/image-archive`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${credential.token}`,
            "content-type": "application/json",
            "x-starlight-resource": credential.resource,
          },
          body: JSON.stringify({
            ...input,
            items: [
              { sourceItemId: input.sourceItemId, storageId: input.storageId },
            ],
            finalizeTurn: false,
          }),
          signal: controller.signal,
        },
      );
    } catch (error) {
      throw new AgentDriverApiError(
        "The Starlight image item archive request did not reach a definitive outcome",
        "outcome-ambiguous",
        null,
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
    const body = (await response.json().catch(() => null)) as unknown;
    if (
      response.ok &&
      isRecord(body) &&
      body["schemaVersion"] === "starlight.agent-image-item-archive.v1" &&
      body["status"] === "archived" &&
      typeof body["replayed"] === "boolean"
    ) {
      return {
        artifactId: text(body["artifactId"], "Agent image artifact ID"),
        nextEventSequence: integer(
          body["nextEventSequence"],
          "Agent next event sequence",
        ),
        replayed: body["replayed"],
      };
    }
    const code = isRecord(body) ? body["code"] : null;
    if (response.status === 401 || code === "resource-mismatch") {
      throw new AgentDriverApiError(
        "The Starlight credential is invalid, expired, or bound to another resource",
        "resource-mismatch",
        response.status,
      );
    }
    if (response.status === 409 || code === "lease-lost") {
      throw new AgentDriverApiError(
        "The durable turn or lease changed; this driver no longer owns it",
        "lease-lost",
        response.status,
      );
    }
    const ambiguous =
      code === "outcome-ambiguous" ||
      (response.status >= 500 && code !== "request-rejected");
    throw new AgentDriverApiError(
      ambiguous
        ? "The Starlight image item archive outcome is ambiguous"
        : `The Starlight image item archive was rejected with HTTP ${String(response.status)}`,
      ambiguous ? "outcome-ambiguous" : "request-rejected",
      response.status,
    );
  }

  async completeImageBatch(input: {
    readonly leaseId: string;
    readonly fencingToken: number;
    readonly expectedSequence: number;
    readonly operationId: string;
    readonly attemptCount: number;
    readonly text: string;
  }) {
    const body = await this.request("/agent/v1/turns/image/complete", {
      method: "POST",
      body: input,
    });
    if (
      body["schemaVersion"] !== "starlight.agent-image-completion.v1" ||
      body["status"] !== "archived" ||
      typeof body["replayed"] !== "boolean"
    ) {
      throw new AgentDriverApiError(
        "Starlight did not confirm the durable image batch completion",
        "outcome-ambiguous",
        200,
      );
    }
    return {
      artifactId: text(body["artifactId"], "Agent image artifact ID"),
      artifactIds: Array.isArray(body["artifactIds"])
        ? body["artifactIds"].map((value) =>
            text(value, "Agent image artifact ID"),
          )
        : [text(body["artifactId"], "Agent image artifact ID")],
      replayed: body["replayed"],
    };
  }

  async completeCapableTextTurn(input: {
    readonly leaseId: string;
    readonly fencingToken: number;
    readonly expectedSequence: number;
    readonly operationId: string;
    readonly text: string;
    readonly attemptCount: number;
  }) {
    const body = await this.request("/agent/v1/turns/image/complete-text", {
      method: "POST",
      body: input,
    });
    if (
      body["schemaVersion"] !== "starlight.agent-capable-completion.v1" ||
      body["status"] !== "completed" ||
      typeof body["replayed"] !== "boolean"
    ) {
      throw new AgentDriverApiError(
        "Starlight did not confirm the capable text turn completion",
        "outcome-ambiguous",
        200,
      );
    }
    return { replayed: body["replayed"] };
  }

  async failImageTurn(input: {
    readonly leaseId: string;
    readonly fencingToken: number;
    readonly expectedSequence: number;
    readonly operationId: string;
    readonly code: string;
    readonly message: string;
    readonly ambiguous: boolean;
    readonly attemptCount?: number;
  }) {
    const body = await this.request("/agent/v1/turns/image/fail", {
      method: "POST",
      body: input,
    });
    if (
      body["schemaVersion"] !== "starlight.agent-image-failure.v1" ||
      (body["status"] !== "failed" && body["status"] !== "ambiguous") ||
      typeof body["replayed"] !== "boolean"
    ) {
      throw new AgentDriverApiError(
        "Starlight did not confirm the terminal image failure",
        "outcome-ambiguous",
        200,
      );
    }
    return { status: body["status"], replayed: body["replayed"] };
  }

  async failTurn(input: {
    readonly leaseId: string;
    readonly fencingToken: number;
    readonly expectedSequence: number;
    readonly code: string;
    readonly message: string;
    readonly idempotencyKey: string;
  }) {
    return transitionResult(
      await this.request("/agent/v1/turns/fail", {
        method: "POST",
        body: input,
      }),
      "failed",
    );
  }

  async relinquishTurn(input: {
    readonly leaseId: string;
    readonly fencingToken: number;
    readonly expectedSequence: number;
    readonly reason: string;
    readonly idempotencyKey: string;
  }) {
    return transitionResult(
      await this.request("/agent/v1/turns/relinquish", {
        method: "POST",
        body: input,
      }),
      "interrupted",
    );
  }
}
