export type JsonRecord = Readonly<Record<string, unknown>>;

export const CREATIVE_DRIVER_BEHAVIOR_PROFILE_VERSION =
  "starlight.creative-driver-behavior-profile.v2" as const;
export const AGENT_DRIVER_INSTRUCTIONS_SCHEMA_VERSION =
  "starlight.agent-driver-instructions.v1" as const;
export const AGENT_SESSION_MEDIA_TOOL_NAME =
  "starlight_resolve_session_media" as const;
export const AGENT_MEDIA_EXECUTION_TOOL_NAME =
  "starlight_propose_media_execution" as const;
export const AGENT_MEDIA_MODEL_SEARCH_TOOL_NAME =
  "starlight_search_media_models" as const;
export const AGENT_MEDIA_MODEL_SCHEMA_TOOL_NAME =
  "starlight_get_media_model_schema" as const;

export const AGENT_MEDIA_EXECUTION_PROPOSAL_TOOL_NAMES = [
  "starlight_propose_voice_design",
  "starlight_propose_adopted_speech",
  "starlight_propose_video",
  "starlight_propose_talking_avatar",
  "starlight_propose_system_image",
] as const;

export const AGENT_CHARACTER_TOOL_NAMES = [
  "starlight_save_character",
  "starlight_revise_character",
] as const;

export type AgentCharacterToolName =
  (typeof AGENT_CHARACTER_TOOL_NAMES)[number];
export type AgentMediaExecutionProposalToolName =
  (typeof AGENT_MEDIA_EXECUTION_PROPOSAL_TOOL_NAMES)[number];
export type AgentMediaToolName =
  | "starlight_create_video"
  | "starlight_design_character_voice"
  | "starlight_create_adopted_speech"
  | "starlight_create_talking_avatar";
export type AgentDriverToolName =
  | AgentCharacterToolName
  | typeof AGENT_SESSION_MEDIA_TOOL_NAME
  | typeof AGENT_MEDIA_EXECUTION_TOOL_NAME
  | typeof AGENT_MEDIA_MODEL_SEARCH_TOOL_NAME
  | typeof AGENT_MEDIA_MODEL_SCHEMA_TOOL_NAME
  | AgentMediaExecutionProposalToolName
  | AgentMediaToolName;

export interface AgentDriverToolDefinition {
  readonly schemaVersion: string;
  readonly name: AgentDriverToolName;
  readonly capability:
    "text" | "image" | "media-video" | "media-voice-design" | "media-speech";
  readonly description: string;
  readonly inputSchema: JsonRecord;
}

export type AgentDriverCapability =
  | "text"
  | "image"
  | "image-input"
  | "media-video"
  | "media-voice-design"
  | "media-speech";
export type AgentExecutionProfile = "auto" | "fast" | "thorough";
export type AgentInputCapability = "image-input";

export interface AgentExecutionRoutingProjection {
  readonly policyVersion: "starlight.agent-routing.v1";
  readonly executionProfile: AgentExecutionProfile;
  readonly reasoningDepth: "adapter-default" | "low" | "high";
  readonly minimumCapability: "text" | "image";
  readonly requiredInputCapabilities: readonly AgentInputCapability[];
  readonly reason:
    | "automatic-capable-conversation"
    | "automatic-with-image-input"
    | "legacy-explicit-image-capability";
}

export interface AgentAttachmentProjection {
  readonly attachmentId: string;
  readonly kind: "image";
  readonly fileName: string;
  readonly mimeType: "image/png" | "image/jpeg" | "image/webp";
  readonly byteLength: number;
  readonly contentHash: string;
  readonly width: number;
  readonly height: number;
  readonly role: "reference" | "edit-source" | "character" | "product" | null;
}

export type AgentMessagePart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "attachment";
      readonly attachment: AgentAttachmentProjection;
    };

export interface AgentToolActionEventProjection {
  readonly actionId: string;
  readonly kind: "character-write" | "image-generation" | "media-operation";
  readonly status: "running" | "completed" | "failed" | "ambiguous";
  readonly operationId: string;
}

export interface AgentCharacterResultProjection {
  readonly characterId: string;
  readonly displayName: string;
  readonly brief: string;
  readonly creativeRole: string;
  readonly lifecycleStatus: "draft";
  readonly version: number;
  readonly path: string;
  readonly portrait: {
    readonly status: "empty" | "selected";
    readonly url: string | null;
    readonly alt: string;
  };
}

export interface AgentObjectReference {
  readonly kind:
    | "character"
    | "production"
    | "storyboard"
    | "operation"
    | "artifact"
    | "decision";
  readonly resourceId: string;
  readonly label: string;
  readonly path?: string | null;
}

export type AgentResponseBlockInput =
  | {
      readonly schemaVersion: "starlight.agent-response-block.v1";
      readonly type: "character-result";
      readonly actionId: string;
    }
  | {
      readonly schemaVersion: "starlight.agent-response-block.v1";
      readonly type: "tool-result";
      readonly title: string;
      readonly summary?: string;
      readonly actionId: string;
      readonly primaryReference?: AgentObjectReference;
      readonly actionLabel?: string;
    }
  | {
      readonly schemaVersion: "starlight.agent-response-block.v1";
      readonly type: "object-result";
      readonly title: string;
      readonly summary?: string;
      readonly reference: AgentObjectReference;
      readonly actionLabel?: string;
    };

export interface AgentDriverAcceptedIntervention {
  readonly interventionId: string;
  readonly expectedTurnId: string;
  readonly sequence: number;
  readonly version: number;
  readonly parts: readonly AgentMessagePart[];
  readonly text: string;
  readonly capability: "text" | "image";
  readonly executionProfile: AgentExecutionProfile;
  readonly requiredInputCapabilities: readonly AgentInputCapability[];
  readonly references: readonly AgentObjectReference[];
  readonly fallbackPolicy: "queue" | "reject";
}

export interface AgentWorkingSetProjection {
  readonly schemaVersion: string;
  readonly videoCatalogue?: JsonRecord;
  readonly sessionMedia?: JsonRecord;
  readonly subject: {
    readonly kind: "unsaved" | "character-bound";
    readonly binding: null | {
      readonly availability: "available" | "unavailable";
      readonly characterId?: string;
      readonly [key: string]: unknown;
    };
    readonly [key: string]: unknown;
  };
  readonly budget: {
    readonly availability: "available" | "unavailable";
    readonly status?: "active" | "paused" | "exhausted";
    readonly [key: string]: unknown;
  };
  readonly operations: readonly {
    readonly operationId: string;
    readonly operationKind: string;
    readonly followThrough: {
      readonly dispatchPolicy:
        | "new-dispatch-allowed"
        | "continue-existing-no-dispatch"
        | "reconcile-existing-no-dispatch";
      readonly [key: string]: unknown;
    };
    readonly [key: string]: unknown;
  }[];
  readonly fencing: {
    readonly turnVersion: number;
    readonly turnEventSequence: number;
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

export interface CreativeDriverBehaviorContract {
  readonly profileVersion: typeof CREATIVE_DRIVER_BEHAVIOR_PROFILE_VERSION;
}

export type AgentMediaExecutionResult =
  | {
      readonly schemaVersion: "starlight.media-execution-result.v1";
      readonly disposition: "accepted";
      readonly proposalId: string;
      readonly requestedOutputCount: number;
      readonly expectedOperationCount: number;
      readonly operations: readonly {
        readonly operationId: string;
        readonly actionId: string;
        readonly ordinal: number;
        readonly status: string;
      }[];
      readonly nextEventSequence: number;
      readonly replayed: boolean;
    }
  | {
      readonly schemaVersion: "starlight.media-execution-result.v1";
      readonly disposition: "clarification-required" | "invalid";
      readonly proposalId: string;
      readonly code: string;
      readonly message: string;
      readonly candidates?: readonly {
        readonly characterId: string;
        readonly displayName: string;
      }[];
      readonly modelAlternatives?: readonly {
        readonly model: string;
        readonly reason: string;
      }[];
      readonly adjustments?: readonly {
        readonly field: "framing";
        readonly requested: string;
        readonly proposed: string;
        readonly reason: string;
      }[];
      readonly nextEventSequence: number;
      readonly replayed: boolean;
    }
  | {
      readonly schemaVersion: "starlight.media-execution-result.v1";
      readonly disposition: "driver-execution-required";
      readonly proposalId: string;
      readonly kind: "system-image";
      readonly variants: readonly {
        readonly ordinal: number;
        readonly prompt: string;
      }[];
      readonly requestedOutputCount: number;
      readonly expectedOperationCount: 1;
      readonly references: readonly {
        readonly artifactId: string;
        readonly fileName: string;
        readonly mimeType: "image/png" | "image/jpeg" | "image/webp";
        readonly byteLength: number;
        readonly contentHash: string;
        readonly width: number | null;
        readonly height: number | null;
      }[];
      readonly nextEventSequence: number;
      readonly replayed: boolean;
    };

export interface AgentSessionMediaResolution {
  readonly disposition: "resolved" | "clarification-required" | "unavailable";
  readonly artifact: null | {
    readonly artifactId: string;
    readonly [key: string]: unknown;
  };
  readonly candidates: readonly Readonly<Record<string, unknown>>[];
}

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as JsonRecord;
}

export function requireCreativeDriverBehaviorProfile(value: unknown) {
  if (value !== CREATIVE_DRIVER_BEHAVIOR_PROFILE_VERSION) {
    throw new Error("Creative-driver behavior profile version is unsupported");
  }
  return { profileVersion: CREATIVE_DRIVER_BEHAVIOR_PROFILE_VERSION } as const;
}

export function requireAgentWorkingSetProjection(
  value: unknown,
): AgentWorkingSetProjection {
  const source = record(value, "Agent working set");
  const subject = record(source["subject"], "Agent working-set subject");
  const budget = record(source["budget"], "Agent working-set budget");
  const fencing = record(source["fencing"], "Agent working-set fencing");
  const operations = source["operations"];
  const videoCatalogue = source["videoCatalogue"];
  const sessionMedia = source["sessionMedia"];
  if (videoCatalogue !== undefined) {
    const catalogue = record(videoCatalogue, "Agent video catalogue");
    if (
      catalogue["schemaVersion"] !== "starlight.agent-video-catalogue.v1" ||
      !Array.isArray(catalogue["routes"])
    ) {
      throw new Error("Agent video catalogue is invalid");
    }
  }
  if (sessionMedia !== undefined) {
    const media = record(sessionMedia, "Agent session-media index");
    if (
      media["schemaVersion"] !== "starlight.agent-session-media.v1" ||
      !Array.isArray(media["entries"])
    ) {
      throw new Error("Agent session-media index is invalid");
    }
  }
  if (
    source["schemaVersion"] !== "starlight.agent-working-set.v1" ||
    (subject["kind"] !== "unsaved" && subject["kind"] !== "character-bound") ||
    (budget["availability"] !== "available" &&
      budget["availability"] !== "unavailable") ||
    !Array.isArray(operations) ||
    typeof fencing["turnVersion"] !== "number" ||
    typeof fencing["turnEventSequence"] !== "number"
  ) {
    throw new Error("Agent working set is invalid");
  }
  return value as AgentWorkingSetProjection;
}

export function requireAgentSessionMediaResolution(
  value: unknown,
): AgentSessionMediaResolution {
  const source = record(value, "Agent session-media resolution");
  const disposition = source["disposition"];
  if (
    disposition !== "resolved" &&
    disposition !== "clarification-required" &&
    disposition !== "unavailable"
  ) {
    throw new Error("Agent session-media resolution disposition is invalid");
  }
  if (!Array.isArray(source["candidates"])) {
    throw new Error("Agent session-media resolution candidates are invalid");
  }
  return value as unknown as AgentSessionMediaResolution;
}

export function isAgentCharacterToolName(
  value: unknown,
): value is AgentCharacterToolName {
  return AGENT_CHARACTER_TOOL_NAMES.some((name) => name === value);
}

export function isAgentMediaExecutionProposalToolName(
  value: unknown,
): value is AgentMediaExecutionProposalToolName {
  return AGENT_MEDIA_EXECUTION_PROPOSAL_TOOL_NAMES.some(
    (name) => name === value,
  );
}

const mediaToolNames: readonly AgentMediaToolName[] = [
  "starlight_create_video",
  "starlight_design_character_voice",
  "starlight_create_adopted_speech",
  "starlight_create_talking_avatar",
];

export function isAgentMediaToolName(
  value: unknown,
): value is AgentMediaToolName {
  return mediaToolNames.some((name) => name === value);
}

export function isAgentDriverToolName(
  value: unknown,
): value is AgentDriverToolName {
  return (
    isAgentCharacterToolName(value) ||
    value === AGENT_SESSION_MEDIA_TOOL_NAME ||
    value === AGENT_MEDIA_EXECUTION_TOOL_NAME ||
    value === AGENT_MEDIA_MODEL_SEARCH_TOOL_NAME ||
    value === AGENT_MEDIA_MODEL_SCHEMA_TOOL_NAME ||
    isAgentMediaExecutionProposalToolName(value) ||
    isAgentMediaToolName(value)
  );
}

const proposalKindByToolName: Readonly<
  Record<AgentMediaExecutionProposalToolName, string>
> = {
  starlight_propose_voice_design: "voice-design",
  starlight_propose_adopted_speech: "adopted-speech",
  starlight_propose_video: "video",
  starlight_propose_talking_avatar: "talking-avatar",
  starlight_propose_system_image: "system-image",
};

export function normalizeAgentMediaExecutionProposalArguments(
  toolName: AgentMediaExecutionProposalToolName,
  value: JsonRecord,
): JsonRecord {
  return Object.freeze({ ...value, kind: proposalKindByToolName[toolName] });
}

export function agentMediaToolOperationKind(input: {
  readonly toolName: AgentMediaToolName;
  readonly arguments: JsonRecord;
}): string | null {
  if (input.toolName === "starlight_design_character_voice")
    return "voice-design";
  if (input.toolName === "starlight_create_adopted_speech")
    return "voice-adopted-speech";
  if (input.toolName === "starlight_create_talking_avatar")
    return "video-talking-avatar";
  const mode = input.arguments["mode"];
  if (mode === "text-to-video") return "video-text-to-video";
  if (mode === "image-to-video") return "video-image-to-video";
  if (mode === "reference-to-video" || mode === "draft-enhance")
    return "video-reference-to-video";
  return null;
}
