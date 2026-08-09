import { createHash } from "node:crypto";

import {
  AGENT_MEDIA_EXECUTION_TOOL_NAME,
  AGENT_MEDIA_MODEL_SCHEMA_TOOL_NAME,
  AGENT_MEDIA_MODEL_SEARCH_TOOL_NAME,
  AGENT_SESSION_MEDIA_TOOL_NAME,
  agentMediaToolOperationKind,
  isAgentCharacterToolName,
  isAgentMediaExecutionProposalToolName,
  isAgentMediaToolName,
  normalizeAgentMediaExecutionProposalArguments,
  type AgentDriverCapability,
  type AgentDriverToolName,
  type AgentExecutionProfile,
  type AgentMediaExecutionResult,
  type AgentToolActionEventProjection,
} from "./protocol.js";
import { validateDynamicToolArguments } from "./dynamic-tool-validation.js";
import {
  admitCreativeMedia,
  createAgentImageMediaContract,
  PortableMediaInspector,
  verifyPortableMediaInspectorRuntime,
} from "./media-inspector.js";

import {
  AgentDriverApiClient,
  AgentDriverApiError,
  type AgentDriverClaim,
} from "./driver-api-client.js";
import {
  CodexAppServerClient,
  CodexAppServerError,
  type CodexMessagePart,
} from "./codex-app-server-client.js";
import {
  STARLIGHT_CLI_VERSION,
  STARLIGHT_DRIVER_PROTOCOL_VERSION,
} from "./version.js";

const POLL_INTERVAL_MS = 1_000;
const PRESENCE_HEARTBEAT_INTERVAL_MS = 15_000;
const PRESENCE_TTL_MS = 45_000;
const LEASE_HEARTBEAT_INTERVAL_MS = 10_000;
const LEASE_DURATION_MS = 30_000;
const INTERVENTION_POLL_INTERVAL_MS = 250;
const ZERO_DISPATCH_TRUTH =
  "No operation was created and no provider work started.";

type DriverSessionContext = Awaited<
  ReturnType<AgentDriverApiClient["getSessionContext"]>
>;

function mediaDispatchBlockMessage(
  workingSet: DriverSessionContext["workingSet"],
  input: {
    readonly toolName: Parameters<
      typeof agentMediaToolOperationKind
    >[0]["toolName"];
    readonly arguments: Readonly<Record<string, unknown>>;
  },
) {
  if (
    workingSet.budget.availability === "available" &&
    (workingSet.budget.status === "paused" ||
      workingSet.budget.status === "exhausted")
  ) {
    return `The workspace media budget is ${workingSet.budget.status}; no new dispatch was started.`;
  }
  const operationKind = agentMediaToolOperationKind(input);
  if (operationKind === null) return null;
  const parentOperationId = input.arguments["parentOperationId"];
  const existing = workingSet.operations.find(
    (operation) =>
      operation.operationKind === operationKind &&
      (operation.followThrough.dispatchPolicy ===
        "continue-existing-no-dispatch" ||
        operation.followThrough.dispatchPolicy ===
          "reconcile-existing-no-dispatch") &&
      parentOperationId !== operation.operationId,
  );
  if (existing === undefined) return null;
  return existing.followThrough.dispatchPolicy ===
    "reconcile-existing-no-dispatch"
    ? `Reconcile existing operation ${existing.operationId}; no replacement dispatch was started.`
    : `Continue existing operation ${existing.operationId}; no replacement dispatch was started.`;
}

function durableWorkingSetSnapshot(
  workingSet: DriverSessionContext["workingSet"],
) {
  return {
    ...workingSet,
    fencing: {
      ...workingSet.fencing,
      turnVersion: 0,
      turnEventSequence: 0,
    },
  };
}

function toolInputFeedback(input: {
  readonly schemaVersion: "starlight.agent-tool-rejection.v1";
  readonly code: "invalid-tool-arguments";
  readonly toolName: AgentDriverToolName;
  readonly field: string;
  readonly message: string;
  readonly nextEventSequence?: number;
  readonly replayed?: boolean;
}) {
  return JSON.stringify({
    ...input,
    disposition: "clarification-required",
    accepted: false,
    operationCreated: false,
    providerDispatchStarted: false,
    guidance: {
      explainInNaturalLanguage: true,
      consultCurrentToolSchema: true,
      consultVideoCatalogueWhenRelevant: true,
      preserveUserIntent: true,
      correctOnlyIntentPreservingMechanicalErrors: true,
      askBeforeSemanticAdjustment: true,
      offerCompatibleValuesOrCatalogueAlternatives: true,
      instruction:
        "Explain the input constraint and a useful next step in natural language. You may correct and retry an unambiguous mechanical mistake, but ask the user before shortening creative content, changing a requested value, changing models, dropping references, or otherwise changing intent. Do not claim that work started unless a later tool call returns an accepted durable operation.",
    },
  });
}

function falselyClaimsRejectedWorkStarted(text: string) {
  const executionClaim =
    /\b(?:(?:i|we)\s+(?:have\s+)?(?:successfully\s+)?(?:started|submitted|queued|dispatched|accepted|created|generated|completed)|(?:(?:the\s+)?(?:operation|request|job|tool call|generation|video|image|voice|output|batch|work)|it)\s+(?:(?:has|have)\s+been|is|are|was|were|got)?\s*(?:started|submitted|queued|dispatched|accepted|created|generated|completed))\b/iu;
  const negation =
    /\b(?:no|not|never|nothing|without|didn['’]?t|couldn['’]?t|wasn['’]?t|isn['’]?t|hasn['’]?t|haven['’]?t)\b/iu;
  return text
    .split(/(?<=[.!?])\s+|\n+/u)
    .some(
      (sentence) => executionClaim.test(sentence) && !negation.test(sentence),
    );
}

export function verifiedRejectedToolResponse(text: string, rejection: string) {
  const explanation = text.trim();
  if (
    explanation.length === 0 ||
    falselyClaimsRejectedWorkStarted(explanation)
  ) {
    return `I couldn't start this yet because ${rejection} ${ZERO_DISPATCH_TRUTH}`;
  }
  if (explanation.includes(ZERO_DISPATCH_TRUTH)) return explanation;
  return `${explanation}\n\n${ZERO_DISPATCH_TRUTH}`;
}

export function classifyMediaExecutionResult(
  result: AgentMediaExecutionResult,
) {
  if (result.disposition === "accepted") {
    return {
      toolSucceeded: true as const,
      durableWorkCreated: true as const,
      rejection: null,
    };
  }
  if (result.disposition === "driver-execution-required") {
    return {
      toolSucceeded: true as const,
      durableWorkCreated: true as const,
      rejection: null,
    };
  }
  return {
    toolSucceeded: result.disposition === "clarification-required",
    durableWorkCreated: false as const,
    rejection: result.message,
  };
}

export interface AgentDriverRuntimeDependencies {
  readonly api?: AgentDriverApiClient;
  readonly codex?: CodexAppServerClient;
  readonly sleep?: (durationMs: number, signal: AbortSignal) => Promise<void>;
  readonly onEvent?: (event: AgentDriverRuntimeEvent) => void;
}

export interface AgentDriverRuntimeEvent {
  readonly schemaVersion: "starlight.driver-event.v1";
  readonly type:
    | "ready"
    | "idle"
    | "claimed"
    | "completed"
    | "failed"
    | "lease-lost"
    | "stopping";
  readonly code: string;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly turnId: string | null;
  readonly safeAction: string;
  readonly humanRequired: boolean;
  readonly surfaceToHuman: boolean;
  readonly suggestedMessage: string | null;
}

interface ActiveTurn {
  readonly claim: AgentDriverClaim;
  nextEventSequence: number;
  outcomeAmbiguous: boolean;
  leaseError: AgentDriverApiError | null;
  interventionError: Error | null;
  imageOperationId: string | null;
  imageOperationTerminal: boolean;
  imageAttemptCount: number;
  imageArchivedCount: number;
  readonly definitiveToolRejections: string[];
  readonly liveMediaSchemas: Map<
    string,
    {
      readonly fingerprint: string;
      readonly inputSchema: Readonly<Record<string, unknown>>;
    }
  >;
  hasSuccessfulToolCall: boolean;
  imageExecution: {
    readonly proposalId: string;
    readonly requestedOutputCount: number;
    readonly variants: readonly {
      readonly ordinal: number;
      readonly prompt: string;
    }[];
    readonly parentOperationId?: string;
    readonly references: Extract<
      AgentMediaExecutionResult,
      { readonly disposition: "driver-execution-required" }
    >["references"];
  } | null;
  readonly resultBlocks: Array<
    | {
        readonly kind: "character";
        readonly actionId: string;
      }
    | {
        readonly kind: "media";
        readonly action: AgentToolActionEventProjection;
        readonly title: string;
        readonly operationStatus: string;
      }
  >;
}

function systemImageBatchPrompt(
  requestedOutputCount: number,
  variants: readonly { readonly ordinal: number; readonly prompt: string }[],
) {
  const orderedVariants = variants
    .map((variant) => `Image ${String(variant.ordinal)}: ${variant.prompt}`)
    .join("\n\n");
  return [
    `Create exactly ${String(requestedOutputCount)} distinct images in this one turn.`,
    "Generate one image for each ordered direction below. These are deliberate sibling outputs, not retries.",
    "Do not collapse the batch to one image and do not ask the user to request each image separately.",
    orderedVariants,
  ].join("\n\n");
}

class ImageDriverError extends Error {
  constructor(
    message: string,
    readonly failureCode:
      | "IMAGE_OUTPUT_MISSING"
      | "IMAGE_CAPABILITY_UNAVAILABLE"
      | "IMAGE_INPUT_UNSUPPORTED"
      | "IMAGE_MEDIA_CORRUPT"
      | "IMAGE_ARCHIVE_FAILED"
      | "IMAGE_REQUEST_REJECTED_BEFORE_DISPATCH"
      | "IMAGE_GENERATION_FAILED",
    readonly ambiguous = false,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "ImageDriverError";
  }
}

function wait(durationMs: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(resolve, durationMs);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

function safeFailureMessage(error: unknown) {
  if (!(error instanceof Error)) return "The local Codex runtime failed.";
  return error.message
    .replaceAll(
      /(?:sk|stl_agent|stl_connect)_[A-Za-z0-9_-]{8,}/gu,
      "[credential]",
    )
    .slice(0, 400);
}

function admittedImageDimensions(
  probe: Awaited<ReturnType<PortableMediaInspector["inspect"]>>,
) {
  const streams = probe.streams.filter(
    (
      stream,
    ): stream is Extract<(typeof probe.streams)[number], { type: "video" }> =>
      stream.type === "video",
  );
  const image = streams[0];
  if (streams.length !== 1 || image === undefined) {
    throw new Error("Validated image did not contain exactly one image stream");
  }
  return { width: image.width, height: image.height };
}

function claimKey(claim: {
  readonly turnId: string;
  readonly recoveryCount: number;
  readonly credentialId: string;
}) {
  return `resident:${claim.credentialId}:${claim.turnId}:recovery-${String(claim.recoveryCount)}`;
}

function commentaryIdempotencyKey(leaseId: string, itemId: string) {
  const itemFingerprint = createHash("sha256")
    .update(itemId)
    .digest("hex")
    .slice(0, 24);
  return `${leaseId}:progress:commentary:${itemFingerprint}`;
}

export class AgentDriverRuntime {
  private readonly api: AgentDriverApiClient;
  private readonly codex: CodexAppServerClient;
  private readonly sleep: (
    durationMs: number,
    signal: AbortSignal,
  ) => Promise<void>;
  private readonly onEvent: (event: AgentDriverRuntimeEvent) => void;
  private active: ActiveTurn | null = null;
  private runtimeError: Error | null = null;
  private stopping = false;
  private advertisedCapabilities: readonly AgentDriverCapability[] = ["text"];
  private advertisedExecutionProfiles: readonly AgentExecutionProfile[] = [
    "auto",
  ];
  private capableImageGeneration = false;
  private driverSessionNamespace = "";

  constructor(dependencies: AgentDriverRuntimeDependencies = {}) {
    this.api = dependencies.api ?? new AgentDriverApiClient();
    this.codex = dependencies.codex ?? new CodexAppServerClient();
    this.sleep = dependencies.sleep ?? wait;
    this.onEvent = dependencies.onEvent ?? (() => undefined);
  }

  private event(
    type: AgentDriverRuntimeEvent["type"],
    message: string,
    turnId: string | null = null,
    override: Partial<
      Pick<
        AgentDriverRuntimeEvent,
        | "code"
        | "severity"
        | "safeAction"
        | "humanRequired"
        | "surfaceToHuman"
        | "suggestedMessage"
      >
    > = {},
  ) {
    const defaultByType: Readonly<
      Record<
        AgentDriverRuntimeEvent["type"],
        Pick<
          AgentDriverRuntimeEvent,
          | "code"
          | "severity"
          | "safeAction"
          | "humanRequired"
          | "surfaceToHuman"
          | "suggestedMessage"
        >
      >
    > = {
      ready: {
        code: "DRIVER_READY",
        severity: "info",
        safeAction: "No action is required.",
        humanRequired: false,
        surfaceToHuman: false,
        suggestedMessage: null,
      },
      idle: {
        code: "DRIVER_IDLE",
        severity: "info",
        safeAction: "No action is required.",
        humanRequired: false,
        surfaceToHuman: false,
        suggestedMessage: null,
      },
      claimed: {
        code: "TURN_CLAIMED",
        severity: "info",
        safeAction: "No action is required.",
        humanRequired: false,
        surfaceToHuman: false,
        suggestedMessage: null,
      },
      completed: {
        code: "TURN_COMPLETED",
        severity: "info",
        safeAction: "No action is required.",
        humanRequired: false,
        surfaceToHuman: false,
        suggestedMessage: null,
      },
      failed: {
        code: "DRIVER_TURN_FAILED",
        severity: "error",
        safeAction:
          "Read the durable turn state before deciding whether to submit new work.",
        humanRequired: false,
        surfaceToHuman: true,
        suggestedMessage: "The local text driver could not complete this turn.",
      },
      "lease-lost": {
        code: "TURN_LEASE_LOST",
        severity: "warning",
        safeAction:
          "Read the durable turn state; do not write with the stale lease.",
        humanRequired: false,
        surfaceToHuman: true,
        suggestedMessage: "The local driver no longer owns this turn lease.",
      },
      stopping: {
        code: "DRIVER_STOPPING",
        severity: "info",
        safeAction: "No action is required.",
        humanRequired: false,
        surfaceToHuman: false,
        suggestedMessage: null,
      },
    };
    this.onEvent({
      schemaVersion: "starlight.driver-event.v1",
      type,
      message,
      turnId,
      ...defaultByType[type],
      ...override,
    });
  }

  async run(signal: AbortSignal) {
    this.runtimeError = null;
    const presenceController = new AbortController();
    const stopPresence = () => presenceController.abort();
    signal.addEventListener("abort", stopPresence, { once: true });
    let presenceHeartbeat = Promise.resolve();
    let presenceAdvertised = false;
    try {
      const [credential, account] = await Promise.all([
        this.api.getCredentialContext(),
        this.codex.accountStatus(),
      ]);
      this.driverSessionNamespace = `${credential.resource}:${credential.workspace.workspaceId}`;
      try {
        this.advertisedExecutionProfiles = (
          await this.codex.executionProfileStatus()
        ).supportedProfiles;
      } catch {
        this.advertisedExecutionProfiles = ["auto"];
      }
      let imageReady = false;
      let imageInputReady = false;
      let imageReason = "image capability handshake failed";
      try {
        const [capability, inputCapability] = await Promise.all([
          this.codex.imageCapabilityStatus(),
          this.codex.imageInputCapabilityStatus(),
          verifyPortableMediaInspectorRuntime(),
        ]);
        imageReady = capability.available;
        imageInputReady = inputCapability.available;
        imageReason = capability.reason;
      } catch (error) {
        imageReason = safeFailureMessage(error);
      }
      this.capableImageGeneration = imageReady;
      this.advertisedCapabilities = [
        "text",
        ...(imageReady ? (["image"] as const) : []),
        ...(imageInputReady ? (["image-input"] as const) : []),
        "media-video",
        "media-voice-design",
        "media-speech",
      ];
      await this.api.heartbeatPresence({
        ttlMs: PRESENCE_TTL_MS,
        runtimeVersion: STARLIGHT_CLI_VERSION,
        capabilities: this.advertisedCapabilities,
        executionProfiles: this.advertisedExecutionProfiles,
      });
      presenceAdvertised = true;
      this.event(
        "ready",
        imageReady
          ? `Driver online for ${credential.workspace.name} with Codex ${account.planType} sign-in and GPT Image 2 ready.`
          : `Driver online for ${credential.workspace.name} with Codex ${account.planType} sign-in; image generation is unavailable (${imageReason}).`,
        null,
        imageReady
          ? {}
          : {
              code: "IMAGE_CAPABILITY_DEGRADED",
              severity: "warning",
              safeAction:
                "Use text turns, then run starlight doctor before requesting an image.",
              surfaceToHuman: true,
              suggestedMessage:
                "The local driver is online for text, but its image capability is unavailable.",
            },
      );
      presenceHeartbeat = this.heartbeatPresence(presenceController.signal);
      while (!signal.aborted) {
        if (this.runtimeError !== null) throw this.runtimeError;
        const turns = await this.api.listPending(1);
        const candidate = turns[0];
        if (candidate === undefined) {
          this.event(
            "idle",
            "Driver online; no queued Starlight turn is waiting.",
          );
          await this.sleep(POLL_INTERVAL_MS, signal);
          continue;
        }
        const claimed = await this.api.claimTurn({
          targetTurnId: candidate.turnId,
          leaseDurationMs: LEASE_DURATION_MS,
          idempotencyKey: claimKey({
            credentialId: credential.credentialId,
            turnId: candidate.turnId,
            recoveryCount: candidate.recoveryCount,
          }),
        });
        if (claimed === null) continue;
        await this.executeClaim(claimed, signal);
      }
    } finally {
      signal.removeEventListener("abort", stopPresence);
      presenceController.abort();
      await presenceHeartbeat;
      await this.shutdownActiveTurn();
      await this.codex.stop();
      if (presenceAdvertised)
        await this.api.reportOffline().catch(() => undefined);
    }
  }

  private async executeClaim(
    claim: AgentDriverClaim,
    outerSignal: AbortSignal,
  ) {
    const active: ActiveTurn = {
      claim,
      nextEventSequence: claim.nextEventSequence,
      outcomeAmbiguous: false,
      leaseError: null,
      interventionError: null,
      imageOperationId: null,
      imageOperationTerminal: false,
      imageAttemptCount: 0,
      imageArchivedCount: 0,
      definitiveToolRejections: [],
      liveMediaSchemas: new Map(),
      hasSuccessfulToolCall: false,
      imageExecution: null,
      resultBlocks: [],
    };
    this.active = active;
    this.event("claimed", "Claimed queued Starlight turn.", claim.turn.turnId);
    const heartbeatController = new AbortController();
    const stopForAbort = () => {
      heartbeatController.abort();
      void this.codex.stop();
    };
    outerSignal.addEventListener("abort", stopForAbort, { once: true });
    const heartbeat = this.heartbeatLease(active, heartbeatController.signal);
    let terminal = false;
    try {
      const progress = await this.api.appendProgress({
        leaseId: claim.lease.leaseId,
        fencingToken: claim.lease.fencingToken,
        expectedSequence: active.nextEventSequence,
        stage: "reasoning",
        message: this.capableImageGeneration
          ? "The local Codex driver is continuing this conversation and will record any tool it actually starts."
          : "The local Codex driver is reasoning through this turn.",
        idempotencyKey: `${claim.lease.leaseId}:progress:reasoning`,
      });
      active.nextEventSequence = progress.nextEventSequence;
      const context = await this.api.getSessionContext(claim.lease, {
        systemImageGeneration: this.capableImageGeneration,
      });
      const currentMessage = context.messages.at(-1);
      if (
        context.session.sessionId !== claim.turn.sessionId ||
        context.activeTurn.turnId !== claim.turn.turnId ||
        context.activeTurn.status !== "running" ||
        context.activeTurn.capability !== claim.turn.capability ||
        JSON.stringify(context.activeTurn.routing) !==
          JSON.stringify(claim.turn.routing) ||
        context.behaviorProfileVersion !== claim.turn.behaviorProfileVersion ||
        context.driverProtocolVersion !== STARLIGHT_DRIVER_PROTOCOL_VERSION ||
        context.driverInstructions === undefined ||
        JSON.stringify(durableWorkingSetSnapshot(context.workingSet)) !==
          JSON.stringify(durableWorkingSetSnapshot(claim.turn.workingSet)) ||
        JSON.stringify(context.activeTurn.requiredInputCapabilities) !==
          JSON.stringify(claim.turn.requiredInputCapabilities) ||
        context.activeTurn.eventSequence + 1 !== active.nextEventSequence ||
        currentMessage?.messageId !== claim.turn.userMessage.messageId ||
        currentMessage.sequence !== claim.turn.userMessage.sequence ||
        currentMessage.role !== "user" ||
        currentMessage.text !== claim.turn.userMessage.text ||
        JSON.stringify(currentMessage.parts) !==
          JSON.stringify(claim.turn.userMessage.parts)
      ) {
        throw new Error(
          "The durable Starlight context does not match the claimed turn",
        );
      }
      const completed = await this.executeCodexClaim(
        active,
        context,
        outerSignal,
      );
      if (!completed) return;
      terminal = true;
      this.event(
        "completed",
        "Completed the Starlight turn.",
        claim.turn.turnId,
      );
    } catch (error) {
      if (this.runtimeError !== null) throw this.runtimeError;
      if (active.leaseError !== null) {
        if (active.leaseError.code === "lease-lost") {
          terminal = true;
          this.event(
            "lease-lost",
            active.leaseError.message,
            claim.turn.turnId,
          );
          return;
        }
        this.event("lease-lost", active.leaseError.message, claim.turn.turnId, {
          code: "TURN_LEASE_HEARTBEAT_AMBIGUOUS",
          severity: "error",
          safeAction:
            "Wait for the lease to settle, then read the durable turn state before recovery.",
          suggestedMessage:
            "The local driver could not confirm its turn lease heartbeat.",
        });
        throw active.leaseError;
      }
      if (outerSignal.aborted) return;
      if (error instanceof AgentDriverApiError && error.code === "lease-lost") {
        terminal = true;
        this.event("lease-lost", error.message, claim.turn.turnId);
        return;
      }
      const executionError = active.interventionError ?? error;
      if (
        active.interventionError instanceof AgentDriverApiError &&
        active.interventionError.code === "outcome-ambiguous"
      ) {
        active.outcomeAmbiguous = true;
        this.event(
          "failed",
          safeFailureMessage(executionError),
          claim.turn.turnId,
          {
            code: "INTERVENTION_RESOLUTION_OUTCOME_AMBIGUOUS",
            safeAction:
              "Read the durable intervention and turn after the lease settles; do not apply or resolve the intervention again blindly.",
            suggestedMessage:
              "Starlight could not confirm the intervention outcome, so the driver stopped without retrying it.",
          },
        );
        throw executionError;
      }
      if (active.outcomeAmbiguous) {
        this.event(
          "failed",
          safeFailureMessage(executionError),
          claim.turn.turnId,
          {
            code: "STARLIGHT_COMPLETION_OUTCOME_AMBIGUOUS",
            safeAction:
              "Read the durable turn state after the lease settles; do not repeat completion blindly.",
            suggestedMessage:
              "Starlight could not confirm whether the completed response was persisted.",
          },
        );
        throw executionError;
      }
      if (
        active.imageOperationId === null &&
        executionError instanceof AgentDriverApiError &&
        executionError.code === "outcome-ambiguous"
      ) {
        active.outcomeAmbiguous = true;
        this.event(
          "failed",
          safeFailureMessage(executionError),
          claim.turn.turnId,
          {
            code: "TOOL_START_OUTCOME_AMBIGUOUS",
            safeAction:
              "Wait for the lease to settle, then recover only from the durable Starlight turn and operation state.",
            suggestedMessage:
              "Starlight could not confirm whether the tool-start event was recorded, so the driver stopped without retrying it.",
          },
        );
        throw executionError;
      }
      const ambiguous =
        (executionError instanceof AgentDriverApiError &&
          executionError.code === "outcome-ambiguous") ||
        (executionError instanceof CodexAppServerError &&
          executionError.code === "turn-outcome-ambiguous") ||
        (executionError instanceof ImageDriverError &&
          executionError.ambiguous);
      const failureCode =
        executionError instanceof ImageDriverError
          ? executionError.failureCode
          : executionError instanceof CodexAppServerError &&
              executionError.code === "image-capability-unavailable"
            ? "IMAGE_CAPABILITY_UNAVAILABLE"
            : executionError instanceof CodexAppServerError &&
                executionError.code === "image-input-unsupported"
              ? "IMAGE_INPUT_UNSUPPORTED"
              : executionError instanceof CodexAppServerError &&
                  executionError.code === "image-output-missing"
                ? "IMAGE_OUTPUT_MISSING"
                : executionError instanceof CodexAppServerError &&
                    executionError.code === "security-boundary-violated"
                  ? "LOCAL_CODEX_SECURITY_BOUNDARY"
                  : active.imageOperationId !== null &&
                      !active.imageOperationTerminal &&
                      executionError instanceof AgentDriverApiError
                    ? "IMAGE_ARCHIVE_FAILED"
                    : ambiguous
                      ? "LOCAL_CODEX_OUTCOME_AMBIGUOUS"
                      : "LOCAL_CODEX_DRIVER_FAILED";
      const failureMessage =
        active.imageOperationId !== null && ambiguous
          ? "The image batch stopped before all requested images reached a definitive outcome. Starlight did not retry unfinished work."
          : safeFailureMessage(executionError);
      try {
        if (
          active.imageOperationId !== null &&
          !active.imageOperationTerminal
        ) {
          if (
            executionError instanceof CodexAppServerError &&
            executionError.code === "turn-outcome-ambiguous"
          ) {
            await this.codex.stop();
          }
          await this.api.failImageTurn({
            leaseId: claim.lease.leaseId,
            fencingToken: claim.lease.fencingToken,
            expectedSequence: active.nextEventSequence,
            operationId: active.imageOperationId,
            code: failureCode,
            message: failureMessage,
            ambiguous,
            attemptCount: active.imageAttemptCount,
          });
          active.imageOperationTerminal = true;
        } else {
          await this.api.failTurn({
            leaseId: claim.lease.leaseId,
            fencingToken: claim.lease.fencingToken,
            expectedSequence: active.nextEventSequence,
            code: failureCode,
            message: failureMessage,
            idempotencyKey: `${claim.lease.leaseId}:fail`,
          });
        }
      } catch (failureError) {
        if (
          failureError instanceof AgentDriverApiError &&
          (failureError.code === "lease-lost" ||
            failureError.code === "outcome-ambiguous")
        ) {
          if (failureError.code === "outcome-ambiguous")
            active.outcomeAmbiguous = true;
          throw failureError;
        }
        throw new Error(
          "The text runtime failed and Starlight could not persist the failure",
          {
            cause: failureError,
          },
        );
      }
      terminal = true;
      this.event("failed", failureMessage, claim.turn.turnId, {
        code: ambiguous
          ? "CODEX_TURN_OUTCOME_AMBIGUOUS"
          : failureCode === "LOCAL_CODEX_SECURITY_BOUNDARY"
            ? "CODEX_SECURITY_BOUNDARY_VIOLATION"
            : failureCode.startsWith("IMAGE_")
              ? failureCode
              : "DRIVER_TURN_FAILED",
        suggestedMessage: ambiguous
          ? "Codex stopped without a definitive turn result; Starlight recorded the failure and did not retry it."
          : failureCode === "LOCAL_CODEX_SECURITY_BOUNDARY"
            ? "Codex attempted a capability outside the driver boundary, so the turn was stopped."
            : "The local Codex driver could not complete this turn.",
      });
    } finally {
      outerSignal.removeEventListener("abort", stopForAbort);
      heartbeatController.abort();
      await heartbeat;
      if (this.active === active && terminal) this.active = null;
    }
  }

  private async executeCodexClaim(
    active: ActiveTurn,
    context: DriverSessionContext,
    outerSignal: AbortSignal,
  ) {
    const claim = active.claim;
    const driverInstructions = context.driverInstructions;
    if (driverInstructions === undefined) {
      throw new Error(
        "The Starlight server did not supply driver instructions",
      );
    }
    const messages = await this.codexMessages(active, context);
    const interventionController = new AbortController();
    const stopInterventions = () => interventionController.abort();
    outerSignal.addEventListener("abort", stopInterventions, { once: true });
    const interventionMonitor = this.monitorInterventions(
      active,
      interventionController.signal,
    );
    try {
      const toolCallbacks = {
        onCommentary: async (input: {
          readonly itemId: string;
          readonly text: string;
        }) => {
          const progress = await this.api.appendProgress({
            leaseId: claim.lease.leaseId,
            fencingToken: claim.lease.fencingToken,
            expectedSequence: active.nextEventSequence,
            stage: "commentary",
            message: input.text,
            idempotencyKey: commentaryIdempotencyKey(
              claim.lease.leaseId,
              input.itemId,
            ),
          });
          active.nextEventSequence = progress.nextEventSequence;
        },
        onDynamicToolCall: async (input: {
          readonly toolName: AgentDriverToolName;
          readonly callId: string;
          readonly arguments: Readonly<Record<string, unknown>>;
        }) => {
          try {
            const sourceRuntimeVersion =
              this.codex.installationStatus()?.installedVersion;
            if (sourceRuntimeVersion === undefined) {
              throw new Error(
                "The Codex runtime version disappeared before the tool callback",
              );
            }
            const definition = driverInstructions.tools.find(
              (candidate) => candidate.name === input.toolName,
            );
            if (definition === undefined) {
              throw new Error(
                "The selected Starlight tool is missing from the authenticated instruction contract",
              );
            }
            const validation = validateDynamicToolArguments(
              definition,
              input.arguments,
            );
            if (!validation.valid) {
              const rejection = await this.api.rejectToolCall({
                leaseId: claim.lease.leaseId,
                fencingToken: claim.lease.fencingToken,
                expectedSequence: active.nextEventSequence,
                toolName: input.toolName,
                callId: input.callId,
                arguments: input.arguments,
                sourceRuntimeVersion,
                driverRuntimeVersion: STARLIGHT_CLI_VERSION,
              });
              active.nextEventSequence = rejection.nextEventSequence;
              active.definitiveToolRejections.push(validation.failure.message);
              return {
                success: false,
                text: toolInputFeedback({
                  ...rejection,
                  field: validation.failure.field,
                  message: validation.failure.message,
                }),
              };
            }
            if (input.toolName === AGENT_MEDIA_MODEL_SEARCH_TOOL_NAME) {
              const result = await this.api.searchMediaModels({
                leaseId: claim.lease.leaseId,
                fencingToken: claim.lease.fencingToken,
                query: String(input.arguments["query"] ?? ""),
              });
              return { success: true, text: JSON.stringify(result) };
            }
            if (input.toolName === AGENT_MEDIA_MODEL_SCHEMA_TOOL_NAME) {
              const endpointId = String(input.arguments["endpointId"] ?? "");
              const result = await this.api.getMediaModelSchema({
                leaseId: claim.lease.leaseId,
                fencingToken: claim.lease.fencingToken,
                endpointId,
              });
              const fingerprint = result["schemaFingerprint"];
              const inputSchema = result["inputSchema"];
              if (
                typeof fingerprint !== "string" ||
                typeof inputSchema !== "object" ||
                inputSchema === null ||
                Array.isArray(inputSchema)
              ) {
                throw new Error(
                  "Starlight returned malformed live media schema evidence",
                );
              }
              active.liveMediaSchemas.set(endpointId, {
                fingerprint,
                inputSchema: inputSchema as Readonly<Record<string, unknown>>,
              });
              return { success: true, text: JSON.stringify(result) };
            }
            if (input.toolName === AGENT_SESSION_MEDIA_TOOL_NAME) {
              const result = await this.api.resolveSessionMedia({
                leaseId: claim.lease.leaseId,
                fencingToken: claim.lease.fencingToken,
                expectedSequence: active.nextEventSequence,
                toolName: input.toolName,
                callId: input.callId,
                arguments: input.arguments,
                sourceRuntimeVersion,
                driverRuntimeVersion: STARLIGHT_CLI_VERSION,
              });
              active.nextEventSequence = result.nextEventSequence;
              if (result.resolution.disposition === "resolved") {
                active.hasSuccessfulToolCall = true;
              }
              return {
                success: result.resolution.disposition === "resolved",
                text: JSON.stringify({
                  schemaVersion: "starlight.agent-session-media-tool-result.v1",
                  ...result,
                  operationCreated: false,
                  providerDispatchStarted: false,
                }),
              };
            }
            if (isAgentCharacterToolName(input.toolName)) {
              const result = await this.api.startCharacterTool({
                leaseId: claim.lease.leaseId,
                fencingToken: claim.lease.fencingToken,
                expectedSequence: active.nextEventSequence,
                toolName: input.toolName,
                callId: input.callId,
                arguments: input.arguments,
                sourceRuntimeVersion,
                driverRuntimeVersion: STARLIGHT_CLI_VERSION,
              });
              active.nextEventSequence = result.nextEventSequence;
              if (
                !active.resultBlocks.some(
                  (entry) =>
                    entry.kind === "character" &&
                    entry.actionId === result.action.actionId,
                )
              ) {
                active.resultBlocks.push({
                  kind: "character",
                  actionId: result.action.actionId,
                });
              }
              active.hasSuccessfulToolCall = true;
              return {
                success: true,
                text: JSON.stringify({
                  schemaVersion: "starlight.agent-character-tool-result.v1",
                  saved: true,
                  change: result.change,
                  actionId: result.action.actionId,
                  character: result.character,
                  replayed: result.replayed,
                  message:
                    result.change === "saved"
                      ? "Starlight saved the private character draft."
                      : "Starlight saved the character draft revision.",
                }),
              };
            }
            if (
              input.toolName === AGENT_MEDIA_EXECUTION_TOOL_NAME ||
              isAgentMediaExecutionProposalToolName(input.toolName)
            ) {
              const executionArguments = isAgentMediaExecutionProposalToolName(
                input.toolName,
              )
                ? normalizeAgentMediaExecutionProposalArguments(
                    input.toolName,
                    input.arguments,
                  )
                : input.arguments;
              if (
                executionArguments["kind"] === "video" ||
                executionArguments["kind"] === "talking-avatar"
              ) {
                const variants = executionArguments["variants"];
                if (!Array.isArray(variants)) {
                  throw new Error("Media variants are missing");
                }
                for (const [index, value] of variants.entries()) {
                  if (
                    typeof value !== "object" ||
                    value === null ||
                    Array.isArray(value)
                  ) {
                    throw new Error(
                      `Media variant ${String(index + 1)} is invalid`,
                    );
                  }
                  const variant = value as Readonly<Record<string, unknown>>;
                  const endpointId = variant["endpointId"];
                  const schemaFingerprint = variant["schemaFingerprint"];
                  const discovered =
                    typeof endpointId === "string"
                      ? active.liveMediaSchemas.get(endpointId)
                      : undefined;
                  if (
                    discovered === undefined ||
                    discovered.fingerprint !== schemaFingerprint
                  ) {
                    return {
                      success: false,
                      text: toolInputFeedback({
                        schemaVersion: "starlight.agent-tool-rejection.v1",
                        code: "invalid-tool-arguments",
                        toolName: input.toolName,
                        field: `arguments.variants.${String(index)}.schemaFingerprint`,
                        message:
                          "Retrieve the exact current endpoint schema in this turn before proposing provider input.",
                      }),
                    };
                  }
                  const providerValidation = validateDynamicToolArguments(
                    {
                      schemaVersion: "starlight.fal-live-schema.v1",
                      name: input.toolName,
                      capability: "media-video",
                      description: "Exact live fal provider input schema.",
                      inputSchema: discovered.inputSchema,
                    },
                    variant["providerInput"],
                  );
                  if (!providerValidation.valid) {
                    return {
                      success: false,
                      text: toolInputFeedback({
                        schemaVersion: "starlight.agent-tool-rejection.v1",
                        code: "invalid-tool-arguments",
                        toolName: input.toolName,
                        field: `arguments.variants.${String(index)}.${providerValidation.failure.field}`,
                        message: providerValidation.failure.message,
                      }),
                    };
                  }
                }
              }
              const result = await this.api.proposeMediaExecution({
                leaseId: claim.lease.leaseId,
                fencingToken: claim.lease.fencingToken,
                expectedSequence: active.nextEventSequence,
                callId: input.callId,
                arguments: executionArguments,
                sourceRuntimeVersion,
                driverRuntimeVersion: STARLIGHT_CLI_VERSION,
              });
              active.nextEventSequence = result.nextEventSequence;
              const outcome = classifyMediaExecutionResult(result);
              if (result.disposition === "accepted") {
                for (const operation of result.operations) {
                  if (
                    active.resultBlocks.some(
                      (entry) =>
                        entry.kind === "media" &&
                        entry.action.actionId === operation.actionId,
                    )
                  ) {
                    continue;
                  }
                  active.resultBlocks.push({
                    kind: "media",
                    action: {
                      actionId: operation.actionId,
                      kind: "media-operation",
                      status: "running",
                      operationId: operation.operationId,
                    },
                    title: `Media output ${String(operation.ordinal)}`,
                    operationStatus: operation.status,
                  });
                }
              } else if (result.disposition === "driver-execution-required") {
                const derivation = executionArguments["derivation"];
                const derivationRecord =
                  typeof derivation === "object" &&
                  derivation !== null &&
                  !Array.isArray(derivation)
                    ? (derivation as Readonly<Record<string, unknown>>)
                    : null;
                const parentOperationId =
                  derivationRecord?.["kind"] === "revision" &&
                  typeof derivationRecord["parentOperationId"] === "string"
                    ? derivationRecord["parentOperationId"]
                    : undefined;
                active.imageExecution = {
                  proposalId: result.proposalId,
                  requestedOutputCount: result.requestedOutputCount,
                  variants: result.variants,
                  references: result.references,
                  ...(parentOperationId === undefined
                    ? {}
                    : { parentOperationId }),
                };
              }
              if (outcome.durableWorkCreated) {
                active.hasSuccessfulToolCall = true;
              } else {
                active.definitiveToolRejections.push(outcome.rejection);
              }
              return {
                success: outcome.toolSucceeded,
                text: JSON.stringify(result),
              };
            }
            if (!isAgentMediaToolName(input.toolName)) {
              throw new Error("The selected Starlight tool is unsupported");
            }
            const blocked = mediaDispatchBlockMessage(context.workingSet, {
              toolName: input.toolName,
              arguments: input.arguments,
            });
            if (blocked !== null) return { success: false, text: blocked };
            const operation = await this.api.startMediaTool({
              leaseId: claim.lease.leaseId,
              fencingToken: claim.lease.fencingToken,
              expectedSequence: active.nextEventSequence,
              toolName: input.toolName,
              callId: input.callId,
              arguments: input.arguments,
              sourceRuntimeVersion,
              driverRuntimeVersion: STARLIGHT_CLI_VERSION,
            });
            active.nextEventSequence = operation.nextEventSequence;
            if (
              !active.resultBlocks.some(
                (entry) =>
                  entry.kind === "media" &&
                  entry.action.actionId === operation.action.actionId,
              )
            ) {
              active.resultBlocks.push({
                kind: "media",
                action: operation.action,
                title: operation.title,
                operationStatus: operation.operationStatus,
              });
            }
            active.hasSuccessfulToolCall = true;
            return {
              success: true,
              text: JSON.stringify({
                schemaVersion: "starlight.agent-media-tool-result.v1",
                accepted: true,
                actionId: operation.action.actionId,
                operationId: operation.action.operationId,
                operationStatus: operation.operationStatus,
                replayed: operation.replayed,
                message:
                  "Starlight durably accepted the operation. It is not a provider-completion receipt.",
              }),
            };
          } catch (error) {
            if (
              error instanceof AgentDriverApiError &&
              error.code === "request-rejected"
            ) {
              if (error.nextEventSequence !== null) {
                active.nextEventSequence = error.nextEventSequence;
              }
              active.definitiveToolRejections.push(safeFailureMessage(error));
              return {
                success: false,
                text: toolInputFeedback({
                  schemaVersion: "starlight.agent-tool-rejection.v1",
                  code: "invalid-tool-arguments",
                  toolName: input.toolName,
                  field: "arguments",
                  message: safeFailureMessage(error),
                }),
              };
            }
            if (
              error instanceof AgentDriverApiError &&
              error.code === "outcome-ambiguous"
            ) {
              active.outcomeAmbiguous = true;
            }
            throw error;
          }
        },
      };
      const response = await this.codex.generateText({
        sessionId: `${this.driverSessionNamespace}:${context.session.sessionId}`,
        sessionTitle: context.session.title,
        turnId: claim.turn.turnId,
        clientUserMessageId: `${claim.turn.turnId}:resolve`,
        systemImageGenerationAvailable: this.capableImageGeneration,
        behaviorProfileVersion: claim.turn.behaviorProfileVersion,
        driverInstructions: driverInstructions.text,
        workingSet: context.workingSet,
        executionProfile: claim.turn.routing.executionProfile,
        messages,
        dynamicTools: driverInstructions.tools,
        callbacks: toolCallbacks,
      });
      if (active.interventionError !== null) throw active.interventionError;
      if (outerSignal.aborted) return false;
      if (!this.capableImageGeneration || active.imageExecution === null) {
        await this.completeTextTurn(active, response);
        return true;
      }
      const sourceRuntimeVersion =
        this.codex.installationStatus()?.installedVersion;
      if (sourceRuntimeVersion === undefined) {
        throw new ImageDriverError(
          "The Codex runtime version disappeared after the capability handshake",
          "IMAGE_GENERATION_FAILED",
        );
      }
      const imageExecution = active.imageExecution;
      const executionPrompt = systemImageBatchPrompt(
        imageExecution.requestedOutputCount,
        imageExecution.variants,
      );
      const resolvedParts = await Promise.all(
        imageExecution.references.map(
          async (reference): Promise<CodexMessagePart> => ({
            type: "attachment",
            attachment: {
              attachmentId: reference.artifactId,
              fileName: reference.fileName,
              mimeType: reference.mimeType,
              contentHash: reference.contentHash,
              bytes: await this.api.downloadMediaExecutionReference({
                leaseId: claim.lease.leaseId,
                fencingToken: claim.lease.fencingToken,
                proposalId: imageExecution.proposalId,
                reference,
              }),
            },
          }),
        ),
      );
      const generated = await this.codex.generateImage({
        sessionId: `${this.driverSessionNamespace}:${context.session.sessionId}:system-image`,
        sessionTitle: context.session.title,
        turnId: claim.turn.turnId,
        clientUserMessageId: `${claim.turn.turnId}:execute:${imageExecution.proposalId}`,
        behaviorProfileVersion: claim.turn.behaviorProfileVersion,
        driverInstructions: driverInstructions.text,
        workingSet: context.workingSet,
        executionProfile: claim.turn.routing.executionProfile,
        messages: [
          ...messages.slice(0, -1),
          {
            role: "user",
            text: executionPrompt,
            parts: [{ type: "text", text: executionPrompt }, ...resolvedParts],
          },
        ],
        dynamicTools: [],
        callbacks: {
          onCommentary: toolCallbacks.onCommentary,
          onImageGenerationStarted: async ({ attempt }) => {
            if (attempt > imageExecution.requestedOutputCount) {
              throw new ImageDriverError(
                "Codex exceeded the accepted system-image output count",
                "IMAGE_GENERATION_FAILED",
                true,
              );
            }
            active.imageAttemptCount = Math.max(
              active.imageAttemptCount,
              attempt,
            );
            if (attempt === 1) {
              const operation = await this.api.startImageTool({
                leaseId: claim.lease.leaseId,
                fencingToken: claim.lease.fencingToken,
                expectedSequence: active.nextEventSequence,
                model: "gpt-image-2",
                tool: "image_generation",
                sourceRuntimeVersion,
                driverRuntimeVersion: STARLIGHT_CLI_VERSION,
                idempotencyKey: `${claim.lease.leaseId}:tool:image:start`,
                proposalId: imageExecution.proposalId,
                proposalOrdinal: 1,
                ...(imageExecution.parentOperationId === undefined
                  ? {}
                  : { parentOperationId: imageExecution.parentOperationId }),
              });
              active.nextEventSequence = operation.nextEventSequence;
              active.imageOperationId = operation.operationId;
              if (
                !operation.dispatchAllowed ||
                operation.dispatchCount !== 1 ||
                operation.replayed
              ) {
                throw new ImageDriverError(
                  "Codex started image generation after Starlight had already recorded a dispatch for this turn",
                  "IMAGE_GENERATION_FAILED",
                  true,
                );
              }
            }
            if (active.imageOperationId === null) {
              throw new ImageDriverError(
                "Codex reported an image before the canonical tool start",
                "IMAGE_GENERATION_FAILED",
                true,
              );
            }
            const progress = await this.api.appendImageToolProgress({
              leaseId: claim.lease.leaseId,
              fencingToken: claim.lease.fencingToken,
              expectedSequence: active.nextEventSequence,
              operationId: active.imageOperationId,
              stage: "generating",
              message: `Image ${String(attempt)} started.`,
              idempotencyKey: `${claim.lease.leaseId}:tool:image:item:${String(attempt)}:started`,
            });
            active.nextEventSequence = progress.nextEventSequence;
          },
          onImageGenerationCompleted: async ({ attempt, status, image }) => {
            if (active.imageOperationId === null) {
              throw new ImageDriverError(
                "Codex completed image generation before the canonical tool start was recorded",
                "IMAGE_GENERATION_FAILED",
                true,
              );
            }
            const progress = await this.api.appendImageToolProgress({
              leaseId: claim.lease.leaseId,
              fencingToken: claim.lease.fencingToken,
              expectedSequence: active.nextEventSequence,
              operationId: active.imageOperationId,
              stage: status === "completed" ? "validating" : "adjusting",
              message:
                status === "completed"
                  ? `Image ${String(attempt)} finished generating; Starlight is validating it.`
                  : `Image ${String(attempt)} ended with status ${status.slice(0, 80)}.`,
              idempotencyKey: `${claim.lease.leaseId}:tool:image:item:${String(attempt)}:terminal`,
            });
            active.nextEventSequence = progress.nextEventSequence;
            if (status !== "completed") return;
            if (image === null) {
              throw new ImageDriverError(
                `Image ${String(attempt)} completed without readable bytes`,
                "IMAGE_OUTPUT_MISSING",
              );
            }
            const admission = await admitCreativeMedia({
              bytes: image.bytes,
              fileName: image.fileName,
              declaredMediaType: image.declaredMediaType,
              contract: createAgentImageMediaContract(image.declaredMediaType),
              inspector: new PortableMediaInspector(),
            });
            if (admission.status !== "admitted") {
              const detail =
                admission.evidence.violations[0]?.message ??
                "Image validation failed.";
              throw new ImageDriverError(detail, "IMAGE_MEDIA_CORRUPT");
            }
            const dimensions = admittedImageDimensions(admission.probe);
            const prepared = await this.api.prepareImageUpload({
              leaseId: claim.lease.leaseId,
              fencingToken: claim.lease.fencingToken,
              operationId: active.imageOperationId,
              contentHash: admission.contentHash,
              mimeType: image.declaredMediaType,
              byteLength: admission.byteCount,
              width: dimensions.width,
              height: dimensions.height,
              sourceItemId: image.codexItemId,
              ...(image.revisedPrompt === null
                ? {}
                : { revisedPrompt: image.revisedPrompt }),
            });
            const uploaded = await this.api.uploadImage({
              uploadUrl: prepared.uploadUrl,
              bytes: image.bytes,
              mimeType: image.declaredMediaType,
            });
            const archived = await this.api.archiveImageItem({
              leaseId: claim.lease.leaseId,
              fencingToken: claim.lease.fencingToken,
              expectedSequence: active.nextEventSequence,
              operationId: active.imageOperationId,
              sourceItemId: image.codexItemId,
              storageId: uploaded.storageId,
              itemNumber: attempt,
              idempotencyKey: `${claim.lease.leaseId}:image:item:${image.codexItemId}:archive`,
            });
            active.nextEventSequence = archived.nextEventSequence;
            active.imageArchivedCount += 1;
          },
        },
      });
      if (active.interventionError !== null) throw active.interventionError;
      if (outerSignal.aborted) return false;
      if (active.imageOperationId === null) {
        if (generated.images.length > 0 || generated.attempts.length > 0) {
          throw new ImageDriverError(
            "Codex returned image activity without a canonical tool-start callback",
            "IMAGE_GENERATION_FAILED",
            true,
          );
        }
        await this.completeTextTurn(active, generated.text);
        return true;
      }
      if (generated.images.length === 0) {
        const failedTool = await this.api.failImageTool({
          leaseId: claim.lease.leaseId,
          fencingToken: claim.lease.fencingToken,
          expectedSequence: active.nextEventSequence,
          operationId: active.imageOperationId,
          code: "IMAGE_GENERATION_FAILED",
          message:
            "Image generation ended without an image. The conversation continued with a text response.",
          ambiguous: false,
          idempotencyKey: `${claim.lease.leaseId}:tool:fail:definitive`,
        });
        active.nextEventSequence = failedTool.nextEventSequence;
        active.imageOperationTerminal = true;
        await this.completeTextTurn(active, generated.text);
        return true;
      }
      if (active.imageArchivedCount !== generated.images.length) {
        throw new ImageDriverError(
          "Starlight did not durably archive every completed image callback",
          "IMAGE_ARCHIVE_FAILED",
          true,
        );
      }
      try {
        await this.api.completeImageBatch({
          leaseId: claim.lease.leaseId,
          fencingToken: claim.lease.fencingToken,
          expectedSequence: active.nextEventSequence,
          operationId: active.imageOperationId,
          attemptCount: generated.attempts.length,
          text: generated.text,
        });
      } catch (error) {
        if (
          error instanceof AgentDriverApiError &&
          error.code === "outcome-ambiguous"
        ) {
          active.outcomeAmbiguous = true;
        }
        throw error;
      }
      return true;
    } finally {
      outerSignal.removeEventListener("abort", stopInterventions);
      interventionController.abort();
      await interventionMonitor;
    }
  }

  private async codexMessages(
    active: ActiveTurn,
    context: DriverSessionContext,
  ) {
    return await Promise.all(
      context.messages.map(async (message, index) => ({
        role: message.role,
        text: message.text,
        ...(index !== context.messages.length - 1
          ? {}
          : {
              parts: await Promise.all(
                message.parts.map(async (part): Promise<CodexMessagePart> => {
                  if (part.type === "text") return part;
                  const bytes = await this.api.downloadAttachment({
                    leaseId: active.claim.lease.leaseId,
                    fencingToken: active.claim.lease.fencingToken,
                    attachment: part.attachment,
                  });
                  return {
                    type: "attachment",
                    attachment: {
                      attachmentId: part.attachment.attachmentId,
                      fileName: part.attachment.fileName,
                      mimeType: part.attachment.mimeType,
                      contentHash: part.attachment.contentHash,
                      bytes,
                    },
                  };
                }),
              ),
            }),
      })),
    );
  }

  private async completeTextTurn(active: ActiveTurn, text: string) {
    const verifiedText =
      !active.hasSuccessfulToolCall &&
      active.resultBlocks.length === 0 &&
      active.definitiveToolRejections.length > 0
        ? verifiedRejectedToolResponse(
            text,
            active.definitiveToolRejections[0] ?? "The input is invalid.",
          )
        : text;
    try {
      await this.api.completeTurn({
        leaseId: active.claim.lease.leaseId,
        fencingToken: active.claim.lease.fencingToken,
        expectedSequence: active.nextEventSequence,
        text: verifiedText,
        ...(active.resultBlocks.length === 0
          ? {}
          : {
              blocks: active.resultBlocks.map((entry) =>
                entry.kind === "character"
                  ? {
                      schemaVersion:
                        "starlight.agent-response-block.v1" as const,
                      type: "character-result" as const,
                      actionId: entry.actionId,
                    }
                  : {
                      schemaVersion:
                        "starlight.agent-response-block.v1" as const,
                      type: "tool-result" as const,
                      title: entry.title,
                      summary: `Durable operation ${entry.action.operationId} is ${entry.operationStatus}.`,
                      actionId: entry.action.actionId,
                    },
              ),
            }),
        idempotencyKey: `${active.claim.lease.leaseId}:complete`,
      });
    } catch (error) {
      if (
        error instanceof AgentDriverApiError &&
        error.code === "outcome-ambiguous"
      ) {
        active.outcomeAmbiguous = true;
      }
      throw error;
    }
  }

  private async monitorInterventions(active: ActiveTurn, signal: AbortSignal) {
    try {
      while (!signal.aborted) {
        const interventions = await this.api.listAcceptedInterventions(
          active.claim.lease,
        );
        for (const intervention of interventions) {
          if (signal.aborted) return;
          let disposition: "applied" | "unsupported" | "cannot-apply";
          if (
            intervention.expectedTurnId !== active.claim.turn.turnId ||
            intervention.executionProfile !==
              active.claim.turn.routing.executionProfile ||
            intervention.requiredInputCapabilities.some(
              (capability) => !this.advertisedCapabilities.includes(capability),
            )
          ) {
            disposition = "unsupported";
          } else {
            const parts = await Promise.all(
              intervention.parts.map(
                async (part): Promise<CodexMessagePart> => {
                  if (part.type === "text") return part;
                  const bytes = await this.api.downloadAttachment({
                    leaseId: active.claim.lease.leaseId,
                    fencingToken: active.claim.lease.fencingToken,
                    attachment: part.attachment,
                  });
                  return {
                    type: "attachment",
                    attachment: {
                      attachmentId: part.attachment.attachmentId,
                      fileName: part.attachment.fileName,
                      mimeType: part.attachment.mimeType,
                      contentHash: part.attachment.contentHash,
                      bytes,
                    },
                  };
                },
              ),
            );
            const steered = await this.codex.steer({
              text: intervention.text,
              parts,
            });
            if (steered.status === "not-active") continue;
            disposition =
              steered.status === "applied"
                ? "applied"
                : steered.status === "unsupported"
                  ? "unsupported"
                  : "cannot-apply";
          }
          await this.api.resolveIntervention({
            leaseId: active.claim.lease.leaseId,
            fencingToken: active.claim.lease.fencingToken,
            interventionId: intervention.interventionId,
            expectedVersion: intervention.version,
            disposition,
            idempotencyKey: `${active.claim.lease.leaseId}:intervention:${String(intervention.sequence)}:${disposition}`,
          });
        }
        await this.sleep(INTERVENTION_POLL_INTERVAL_MS, signal);
      }
    } catch (error) {
      if (signal.aborted) return;
      active.interventionError =
        error instanceof Error
          ? error
          : new Error("The intervention monitor failed");
      await this.codex.stop();
    }
  }

  private async heartbeatPresence(signal: AbortSignal) {
    while (!signal.aborted) {
      await this.sleep(PRESENCE_HEARTBEAT_INTERVAL_MS, signal);
      if (signal.aborted) return;
      try {
        await this.api.heartbeatPresence({
          ttlMs: PRESENCE_TTL_MS,
          runtimeVersion: STARLIGHT_CLI_VERSION,
          capabilities: this.advertisedCapabilities,
          executionProfiles: this.advertisedExecutionProfiles,
        });
      } catch (error) {
        this.runtimeError =
          error instanceof Error
            ? error
            : new Error("The resident driver presence heartbeat failed");
        await this.codex.stop();
        return;
      }
    }
  }

  private async heartbeatLease(active: ActiveTurn, signal: AbortSignal) {
    while (!signal.aborted) {
      await this.sleep(LEASE_HEARTBEAT_INTERVAL_MS, signal);
      if (signal.aborted) return;
      try {
        await this.api.heartbeatTurn({
          leaseId: active.claim.lease.leaseId,
          fencingToken: active.claim.lease.fencingToken,
          leaseDurationMs: LEASE_DURATION_MS,
        });
      } catch (error) {
        const failure =
          error instanceof AgentDriverApiError
            ? error
            : new AgentDriverApiError(
                "The Starlight lease heartbeat failed without a definitive outcome",
                "outcome-ambiguous",
                null,
                { cause: error },
              );
        active.leaseError = failure;
        if (failure.code === "outcome-ambiguous") {
          active.outcomeAmbiguous = true;
        }
        await this.codex.stop();
        return;
      }
    }
  }

  private async shutdownActiveTurn() {
    if (this.stopping) return;
    this.stopping = true;
    const active = this.active;
    this.event(
      "stopping",
      "Stopping the local Codex driver.",
      active?.claim.turn.turnId ?? null,
    );
    if (active === null || active.outcomeAmbiguous) return;
    try {
      if (active.imageOperationId === null || active.imageOperationTerminal) {
        await this.api.relinquishTurn({
          leaseId: active.claim.lease.leaseId,
          fencingToken: active.claim.lease.fencingToken,
          expectedSequence: active.nextEventSequence,
          reason: "The local text driver stopped before this turn completed.",
          idempotencyKey: `${active.claim.lease.leaseId}:relinquish:shutdown`,
        });
      } else {
        await this.api.failImageTurn({
          leaseId: active.claim.lease.leaseId,
          fencingToken: active.claim.lease.fencingToken,
          expectedSequence: active.nextEventSequence,
          operationId: active.imageOperationId,
          code: "IMAGE_DRIVER_STOPPED_AMBIGUOUS",
          message:
            "The local image driver stopped after dispatch. Starlight did not retry the operation.",
          ambiguous: true,
          attemptCount: active.imageAttemptCount,
        });
        active.imageOperationTerminal = true;
      }
    } catch (error) {
      this.event(
        "lease-lost",
        safeFailureMessage(error),
        active.claim.turn.turnId,
        {
          code:
            error instanceof AgentDriverApiError && error.code === "lease-lost"
              ? "TURN_RELINQUISH_LEASE_LOST"
              : "TURN_RELINQUISH_OUTCOME_UNCONFIRMED",
          severity:
            error instanceof AgentDriverApiError && error.code === "lease-lost"
              ? "warning"
              : "error",
          safeAction:
            "Wait for the lease to settle, then recover only from the durable Starlight turn state.",
          suggestedMessage:
            "The driver stopped, but Starlight could not confirm immediate release of its turn lease.",
        },
      );
    }
  }
}
