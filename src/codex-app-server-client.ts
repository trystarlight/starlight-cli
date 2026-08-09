import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
  createInterface,
  type Interface as ReadlineInterface,
} from "node:readline";
import { promisify } from "node:util";

import type {
  AgentDriverToolDefinition,
  AgentDriverToolName,
  AgentExecutionProfile,
  AgentWorkingSetProjection,
  CreativeDriverBehaviorContract,
} from "./protocol.js";
import { CREATIVE_DRIVER_BEHAVIOR_PROFILE_VERSION } from "./protocol.js";

import {
  inspectCodexRuntime,
  type CodexRuntimeInstallation,
} from "./codex-runtime-discovery.js";
import {
  FileCodexThreadStore,
  type CodexThreadStore,
} from "./codex-thread-store.js";
import { STARLIGHT_CLI_VERSION } from "./version.js";

type JsonRecord = Readonly<Record<string, unknown>>;

export interface CodexTextInput {
  readonly sessionId?: string;
  readonly sessionTitle: string;
  readonly turnId: string;
  readonly clientUserMessageId?: string;
  readonly systemImageGenerationAvailable?: boolean;
  readonly behaviorProfileVersion?: CreativeDriverBehaviorContract["profileVersion"];
  readonly driverInstructions?: string;
  readonly workingSet?: AgentWorkingSetProjection;
  readonly executionProfile?: AgentExecutionProfile;
  readonly dynamicTools?: readonly AgentDriverToolDefinition[];
  readonly callbacks?: CodexTurnCallbacks;
  readonly messages: readonly {
    readonly role: "user" | "assistant";
    readonly text: string;
    readonly parts?: readonly CodexMessagePart[];
  }[];
}

interface CodexInputAttachment {
  readonly attachmentId: string;
  readonly fileName: string;
  readonly mimeType: "image/png" | "image/jpeg" | "image/webp";
  readonly contentHash: string;
  readonly bytes: Uint8Array;
}

export type CodexMessagePart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "attachment"; readonly attachment: CodexInputAttachment };

export interface CodexTurnCallbacks {
  readonly onCommentary?: (input: {
    readonly itemId: string;
    readonly text: string;
  }) => Promise<void>;
  readonly onDynamicToolCall?: (input: {
    readonly toolName: AgentDriverToolName;
    readonly callId: string;
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly threadId: string;
    readonly turnId: string;
  }) => Promise<{
    readonly success: boolean;
    readonly text: string;
  }>;
  readonly onImageGenerationStarted?: (input: {
    readonly itemId: string;
    readonly attempt: number;
  }) => Promise<void>;
  readonly onImageGenerationCompleted?: (input: {
    readonly itemId: string;
    readonly attempt: number;
    readonly status: string;
    readonly image: CodexImageResult | null;
  }) => Promise<void>;
}

export type CodexImageInput = CodexTextInput;

export type CodexSteerResult =
  | { readonly status: "applied"; readonly turnId: string }
  | {
      readonly status: "not-active" | "unsupported" | "cannot-apply";
      readonly turnId: null;
    };

export interface CodexAccountStatus {
  readonly type: "chatgpt";
  readonly planType: string;
}

export interface CodexImageCapabilityStatus {
  readonly available: boolean;
  readonly reason:
    "ready" | "runtime-capability-unavailable" | "imagegen-skill-unavailable";
  readonly skillPath: string | null;
  readonly codexRuntimeVersion: string;
}

export interface CodexImageInputCapabilityStatus {
  readonly available: boolean;
  readonly reason: "ready" | "default-model-does-not-support-image-input";
  readonly modelId: string | null;
}

export interface CodexExecutionProfileStatus {
  readonly modelId: string | null;
  readonly supportedProfiles: readonly AgentExecutionProfile[];
}

export interface CodexImageResult {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly declaredMediaType: "image/png" | "image/jpeg" | "image/webp";
  readonly codexItemId: string;
  readonly revisedPrompt: string | null;
  readonly model: "gpt-image-2";
  readonly tool: "image_generation";
  readonly codexRuntimeVersion: string;
}

interface CodexImageAttempt {
  readonly codexItemId: string;
  readonly status: string;
  readonly revisedPrompt: string | null;
  readonly result: string;
}

export interface CodexCapableTurnResult {
  readonly text: string;
  readonly images: readonly CodexImageResult[];
  readonly attempts: readonly CodexImageAttempt[];
  readonly moderation: readonly string[];
}

export type CodexAppServerErrorCode =
  | "runtime-unavailable"
  | "runtime-incompatible"
  | "protocol-mismatch"
  | "app-server-unavailable"
  | "chatgpt-auth-required"
  | "chatgpt-auth-unsupported"
  | "image-capability-unavailable"
  | "execution-profile-unavailable"
  | "image-input-unsupported"
  | "image-output-missing"
  | "turn-failed"
  | "turn-outcome-ambiguous"
  | "security-boundary-violated"
  | "stopped";

export class CodexAppServerError extends Error {
  constructor(
    message: string,
    readonly code: CodexAppServerErrorCode,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "CodexAppServerError";
  }
}

export interface CodexAppServerClientDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly inspectRuntime?: (
    environment?: NodeJS.ProcessEnv,
  ) => Promise<CodexRuntimeInstallation | null>;
  readonly spawn?: typeof spawn;
  readonly discoverMcpServerNames?: (
    installation: CodexRuntimeInstallation,
    environment: NodeJS.ProcessEnv,
    cwd: string,
  ) => Promise<readonly string[]>;
  readonly createWorkspace?: () => Promise<string>;
  readonly removeWorkspace?: (path: string) => Promise<void>;
  readonly threadStore?: CodexThreadStore;
  readonly requestTimeoutMs?: number;
  readonly turnTimeoutMs?: number;
  readonly turnAbsoluteTimeoutMs?: number;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
}

interface PendingTurn {
  readonly turnId: string;
  readonly resolve: (value: JsonRecord) => void;
  readonly reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  readonly hardDeadlineAt: number;
}

class CodexRpcError extends Error {
  constructor(
    message: string,
    readonly rpcCode: number | null,
  ) {
    super(message);
    this.name = "CodexRpcError";
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string) {
  if (!isRecord(value)) throw new Error(`${label} is invalid`);
  return value;
}

function text(value: unknown, label: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is missing`);
  }
  return value;
}

function sanitizedLine(value: string) {
  return value
    .replaceAll(
      /(?:sk|stl_agent|stl_connect)_[A-Za-z0-9_-]{8,}/gu,
      "[credential]",
    )
    .slice(0, 400);
}

function sanitizedCommentary(value: unknown) {
  if (typeof value !== "string") return null;
  const sanitized = value
    .replaceAll(
      /(?:sk|stl_agent|stl_connect)_[A-Za-z0-9_-]{8,}/gu,
      "[credential]",
    )
    .trim()
    .slice(0, 800)
    .trim();
  return sanitized.length > 0 ? sanitized : null;
}

function profileEffort(profile: AgentExecutionProfile) {
  if (profile === "fast") return "low" as const;
  if (profile === "thorough") return "high" as const;
  return undefined;
}

function childEnvironment(environment: NodeJS.ProcessEnv) {
  const result: NodeJS.ProcessEnv = {
    PATH:
      environment["PATH"] ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
  };
  for (const key of [
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "CODEX_HOME",
    "LANG",
    "LC_ALL",
  ]) {
    const value = environment[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function configuredCodexHome(environment: NodeJS.ProcessEnv) {
  const configured = environment["CODEX_HOME"];
  const value =
    configured === undefined
      ? environment["HOME"] === undefined
        ? null
        : join(environment["HOME"], ".codex")
      : configured;
  return value !== null && isAbsolute(value) ? resolve(value) : null;
}

function isNestedPath(root: string, candidate: string) {
  const nested = relative(root, candidate);
  return nested.length > 0 && !nested.startsWith("..") && !isAbsolute(nested);
}

const execFileAsync = promisify(execFile);

async function discoverMcpServerNames(
  installation: CodexRuntimeInstallation,
  environment: NodeJS.ProcessEnv,
  cwd: string,
) {
  let stdout: string;
  try {
    const result = await execFileAsync(
      installation.executable,
      ["mcp", "list", "--json", "--disable", "hooks", "--disable", "plugins"],
      {
        cwd,
        env: childEnvironment(environment),
        timeout: 15_000,
        maxBuffer: 1_000_000,
        encoding: "utf8",
      },
    );
    stdout = result.stdout;
  } catch (error) {
    throw new CodexAppServerError(
      "Codex MCP configuration could not be bounded for the local driver",
      "security-boundary-violated",
      { cause: error },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new CodexAppServerError(
      "Codex MCP configuration returned an invalid inventory",
      "security-boundary-violated",
      { cause: error },
    );
  }
  if (!Array.isArray(parsed) || parsed.length > 256) {
    throw new CodexAppServerError(
      "Codex MCP configuration exceeded the local driver boundary",
      "security-boundary-violated",
    );
  }
  return parsed.map((entry) => {
    const name = isRecord(entry) ? entry["name"] : null;
    if (typeof name !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(name)) {
      throw new CodexAppServerError(
        "Codex MCP configuration contains an unsupported server identity",
        "security-boundary-violated",
      );
    }
    return name;
  });
}

function appServerArguments(mcpServerNames: readonly string[]) {
  const mcpOverrides = mcpServerNames.flatMap((name) => [
    "-c",
    `mcp_servers.${name}.enabled=false`,
  ]);
  return [
    "app-server",
    "--stdio",
    "--disable",
    "hooks",
    "--disable",
    "shell_tool",
    "--disable",
    "unified_exec",
    "--disable",
    "code_mode_host",
    "--disable",
    "apps",
    "--disable",
    "browser_use",
    "--disable",
    "computer_use",
    "--disable",
    "multi_agent",
    "--disable",
    "in_app_browser",
    "--disable",
    "plugins",
    "--disable",
    "tool_suggest",
    "--disable",
    "workspace_dependencies",
    "--disable",
    "skill_mcp_dependency_install",
    "-c",
    'web_search="live"',
    "-c",
    "notify=[]",
    "-c",
    "project_doc_max_bytes=0",
    "-c",
    "project_doc_fallback_filenames=[]",
    "-c",
    "skills.include_instructions=false",
    "-c",
    "include_permissions_instructions=false",
    "-c",
    "include_apps_instructions=false",
    "-c",
    "include_collaboration_mode_instructions=false",
    "-c",
    "include_environment_context=false",
    "-c",
    "plugins={}",
    ...mcpOverrides,
  ] as const;
}

function baseInstructions(input: {
  readonly behaviorProfileVersion: CreativeDriverBehaviorContract["profileVersion"];
  readonly systemImageGeneration: boolean;
  readonly dynamicTools: readonly AgentDriverToolDefinition[];
  readonly workingSetSupplied: boolean;
  readonly serverInstructions?: string;
}) {
  if (
    input.serverInstructions === undefined ||
    input.serverInstructions.trim().length === 0
  ) {
    throw new CodexAppServerError(
      "The Starlight server did not provide versioned driver instructions.",
      "protocol-mismatch",
    );
  }
  return input.serverInstructions;
}

function workingSetContext(workingSet: AgentWorkingSetProjection | undefined) {
  return workingSet === undefined
    ? {}
    : {
        starlightWorkingSet: {
          kind: "untrusted" as const,
          value: JSON.stringify(workingSet),
        },
      };
}

function mediaExecutionContext(
  workingSet: AgentWorkingSetProjection | undefined,
) {
  if (workingSet === undefined) return {};
  const binding = workingSet.subject.binding;
  const subject =
    workingSet.subject.kind === "character-bound" &&
    binding !== null &&
    binding.availability === "available"
      ? { kind: "character-id" as const, characterId: binding.characterId }
      : workingSet.subject.kind === "character-bound"
        ? { kind: "current-character" as const }
        : { kind: "none" as const };
  return {
    starlightMediaExecution: {
      kind: "untrusted" as const,
      value: JSON.stringify({
        defaultSubject: subject,
        newDerivation: { kind: "new" },
        instruction:
          workingSet.subject.kind === "unsaved"
            ? "The current working subject is unsaved. Use defaultSubject exactly; do not copy its subjectId or label into a media proposal."
            : "Use defaultSubject for the current saved Character unless the latest user request explicitly names another saved Character.",
      }),
    },
  };
}

function transcript(messages: CodexTextInput["messages"]) {
  const entries = messages
    .slice(0, -1)
    .slice(-40)
    .map(
      (message) =>
        `${message.role === "user" ? "USER" : "ASSISTANT"}:\n${message.text}`,
    )
    .join("\n\n");
  return entries.length <= 100_000 ? entries : entries.slice(-100_000);
}

function dynamicToolSpecs(
  definitions: readonly AgentDriverToolDefinition[] | undefined,
) {
  const tools = definitions ?? [];
  const names = new Set<string>();
  return tools.map((tool) => {
    if (names.has(tool.name)) {
      throw new CodexAppServerError(
        `Starlight supplied duplicate dynamic tool ${tool.name}`,
        "security-boundary-violated",
      );
    }
    names.add(tool.name);
    return {
      type: "function" as const,
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      deferLoading: false,
    };
  });
}

function finalText(turn: JsonRecord, allowDynamicTools = false) {
  if (turn["status"] !== "completed") {
    const error = isRecord(turn["error"]) ? turn["error"]["message"] : null;
    throw new CodexAppServerError(
      typeof error === "string" && error.length > 0
        ? `Codex turn failed: ${error}`
        : `Codex turn ended with status ${String(turn["status"])}`,
      "turn-failed",
    );
  }
  const items = turn["items"];
  if (!Array.isArray(items))
    throw new Error("Codex completed turn items are invalid");
  const disallowed = items.find(
    (item) =>
      isRecord(item) &&
      typeof item["type"] === "string" &&
      item["type"] !== "userMessage" &&
      item["type"] !== "agentMessage" &&
      item["type"] !== "reasoning" &&
      item["type"] !== "webSearch" &&
      !(allowDynamicTools && item["type"] === "dynamicToolCall"),
  );
  if (isRecord(disallowed)) {
    throw new CodexAppServerError(
      `Codex attempted disallowed ${String(disallowed["type"])} activity in the text-only driver`,
      "security-boundary-violated",
    );
  }
  const agentMessages = items.filter(
    (item): item is JsonRecord =>
      isRecord(item) &&
      item["type"] === "agentMessage" &&
      item["phase"] !== "commentary",
  );
  const message = agentMessages.at(-1);
  const raw = text(message?.["text"], "Codex final response");
  let structured: unknown;
  try {
    structured = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new CodexAppServerError(
      "Codex final response did not satisfy the text-driver schema",
      "turn-failed",
      {
        cause: error,
      },
    );
  }
  const result = record(structured, "Codex structured response");
  const response = text(result["response"], "Codex structured response text");
  if (response.length > 20_000) {
    throw new CodexAppServerError(
      "Codex final response exceeded the text-driver size boundary",
      "turn-failed",
    );
  }
  return response;
}

function imageMediaType(
  bytes: Uint8Array,
): CodexImageResult["declaredMediaType"] {
  const has = (prefix: readonly number[]) =>
    prefix.every((value, index) => bytes[index] === value);
  if (has([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (has([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (
    bytes.byteLength >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  throw new CodexAppServerError(
    "Codex image output has an unsupported or missing media signature",
    "image-output-missing",
  );
}

function completedTurnItems(turn: JsonRecord, allowDynamicTools = false) {
  if (turn["status"] !== "completed") {
    const error = isRecord(turn["error"]) ? turn["error"]["message"] : null;
    throw new CodexAppServerError(
      typeof error === "string" && error.length > 0
        ? `Codex image turn failed: ${error}`
        : `Codex image turn ended with status ${String(turn["status"])}`,
      "turn-failed",
    );
  }
  const items = turn["items"];
  if (!Array.isArray(items))
    throw new Error("Codex completed image turn items are invalid");
  const allowed = new Set([
    "userMessage",
    "agentMessage",
    "reasoning",
    "webSearch",
    "imageGeneration",
    ...(allowDynamicTools ? ["dynamicToolCall"] : []),
  ]);
  const disallowed = items.find(
    (item) =>
      isRecord(item) &&
      typeof item["type"] === "string" &&
      !allowed.has(item["type"]),
  );
  if (isRecord(disallowed)) {
    throw new CodexAppServerError(
      `Codex attempted disallowed ${String(disallowed["type"])} activity in the image driver`,
      "security-boundary-violated",
    );
  }
  return items.filter(isRecord);
}

function capableTurnSummary(turn: JsonRecord, allowDynamicTools = false) {
  const items = completedTurnItems(turn, allowDynamicTools);
  const imageItems = items.filter(
    (item): item is JsonRecord =>
      isRecord(item) && item["type"] === "imageGeneration",
  );
  const messages = items.filter(
    (item) => item["type"] === "agentMessage" && item["phase"] !== "commentary",
  );
  const finalMessage = messages.at(-1);
  const response =
    typeof finalMessage?.["text"] === "string" &&
    finalMessage["text"].trim().length > 0
      ? finalMessage["text"].trim()
      : imageItems.some((item) => item["status"] === "completed")
        ? "Created image output and saved it to this Starlight session."
        : "Codex completed without producing an image.";
  if (response.length > 20_000) {
    throw new CodexAppServerError(
      "Codex final response exceeded the capable-driver size boundary",
      "turn-failed",
    );
  }
  return { response, imageItems };
}

export class CodexAppServerClient {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly inspectRuntime: NonNullable<
    CodexAppServerClientDependencies["inspectRuntime"]
  >;
  private readonly spawnProcess: typeof spawn;
  private readonly discoverMcpServerNames: NonNullable<
    CodexAppServerClientDependencies["discoverMcpServerNames"]
  >;
  private readonly createWorkspace: () => Promise<string>;
  private readonly removeWorkspace: (path: string) => Promise<void>;
  private readonly threadStore: CodexThreadStore;
  private readonly requestTimeoutMs: number;
  private readonly turnTimeoutMs: number;
  private readonly turnAbsoluteTimeoutMs: number;
  private process: ChildProcessWithoutNullStreams | null = null;
  private lines: ReadlineInterface | null = null;
  private workspace: string | null = null;
  private installation: CodexRuntimeInstallation | null = null;
  private disabledMcpServerNames: readonly string[] = [];
  private requestId = 0;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly pendingTurns = new Map<string, PendingTurn>();
  private readonly completedTurns = new Map<string, JsonRecord>();
  private readonly completedItems = new Map<string, JsonRecord[]>();
  private readonly imageGenerationStarts = new Map<string, number>();
  private readonly imageGenerationAttempts = new Map<string, number>();
  private readonly completedImageResults = new Map<string, CodexImageResult>();
  private readonly sessionThreads = new Map<string, string>();
  private readonly turnCallbacks = new Map<string, CodexTurnCallbacks>();
  private readonly turnDynamicToolNames = new Map<
    string,
    ReadonlySet<string>
  >();
  private readonly dynamicToolCalls = new Map<
    string,
    Promise<{ readonly success: boolean; readonly text: string }>
  >();
  private readonly turnCallbackTasks = new Map<string, Promise<void>>();
  private readonly turnCallbackErrors = new Map<string, Error>();
  private readonly turnErrors = new Map<string, string[]>();
  private readonly turnModeration = new Map<string, string[]>();
  private readonly stderrTail: string[] = [];
  private securityViolation: Error | null = null;
  private activeTurn: {
    readonly threadId: string;
    readonly turnId: string;
  } | null = null;
  private activeCapability: "text" | "image" | null = null;
  private turnStartCallbacks: CodexTurnCallbacks | null = null;
  private turnStartDynamicTools: {
    readonly threadId: string;
    readonly names: ReadonlySet<string>;
  } | null = null;
  private turnStartInFlight = false;
  private initialized = false;
  private stoppingPromise: Promise<void> | null = null;

  constructor(dependencies: CodexAppServerClientDependencies = {}) {
    this.environment = dependencies.environment ?? process.env;
    this.inspectRuntime = dependencies.inspectRuntime ?? inspectCodexRuntime;
    this.spawnProcess = dependencies.spawn ?? spawn;
    this.discoverMcpServerNames =
      dependencies.discoverMcpServerNames ?? discoverMcpServerNames;
    this.createWorkspace =
      dependencies.createWorkspace ??
      (async () => {
        const root = join(tmpdir(), "starlight-codex-driver-");
        const path = await mkdtemp(root);
        await mkdir(path, { recursive: true, mode: 0o700 });
        return path;
      });
    this.removeWorkspace =
      dependencies.removeWorkspace ??
      (async (path) => await rm(path, { recursive: true, force: true }));
    const driverHome = this.environment["HOME"];
    this.threadStore =
      dependencies.threadStore ??
      new FileCodexThreadStore(
        driverHome !== undefined && isAbsolute(driverHome)
          ? join(driverHome, ".starlight", "codex-driver-threads.json")
          : undefined,
      );
    this.requestTimeoutMs = dependencies.requestTimeoutMs ?? 20_000;
    this.turnTimeoutMs = dependencies.turnTimeoutMs ?? 10 * 60_000;
    this.turnAbsoluteTimeoutMs =
      dependencies.turnAbsoluteTimeoutMs ?? 60 * 60_000;
  }

  async start() {
    if (this.process !== null) return;
    const installation = await this.inspectRuntime(this.environment);
    if (installation === null) {
      throw new CodexAppServerError(
        "Codex is not installed or is not on PATH",
        "runtime-unavailable",
      );
    }
    if (!installation.compatible) {
      throw new CodexAppServerError(
        `Codex ${installation.installedVersion} is incompatible; ${installation.minimumVersion} or newer is required`,
        "runtime-incompatible",
      );
    }
    const workspace = await this.createWorkspace();
    let mcpServerNames: readonly string[];
    try {
      mcpServerNames = await this.discoverMcpServerNames(
        installation,
        this.environment,
        workspace,
      );
    } catch (error) {
      await this.removeWorkspace(workspace);
      throw error;
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnProcess(
        installation.executable,
        appServerArguments(mcpServerNames),
        {
          cwd: workspace,
          env: childEnvironment(this.environment),
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
    } catch (error) {
      await this.removeWorkspace(workspace);
      throw new CodexAppServerError(
        "Codex App Server could not be launched",
        "app-server-unavailable",
        { cause: error },
      );
    }
    this.installation = installation;
    this.disabledMcpServerNames = mcpServerNames;
    this.workspace = workspace;
    this.process = child;
    this.securityViolation = null;
    this.stderrTail.length = 0;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.receiveLine(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/u)) {
        if (!line) continue;
        this.stderrTail.push(sanitizedLine(line));
        if (this.stderrTail.length > 12) this.stderrTail.shift();
      }
    });
    child.once("error", (error) =>
      this.failAll(this.processFailure("failed to start", error)),
    );
    child.once("exit", (code, signal) => {
      const detail = this.stderrTail.at(-1);
      this.failAll(
        this.processFailure(
          `Codex App Server exited${code === null ? "" : ` with code ${String(code)}`}${
            signal === null ? "" : ` after ${signal}`
          }${detail === undefined ? "" : `: ${detail}`}`,
        ),
      );
      this.process = null;
    });
    try {
      await this.request("initialize", {
        clientInfo: {
          name: "starlight",
          title: "Starlight local Codex driver",
          version: STARLIGHT_CLI_VERSION,
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          mcpServerOpenaiFormElicitation: false,
        },
      });
      this.notify("initialized", {});
      this.initialized = true;
    } catch (error) {
      await this.stop();
      throw new CodexAppServerError(
        "Codex App Server did not complete protocol initialization",
        "app-server-unavailable",
        { cause: error },
      );
    }
  }

  async accountStatus(): Promise<CodexAccountStatus> {
    await this.start();
    let result: JsonRecord;
    try {
      result = record(
        await this.request("account/read", { refreshToken: true }),
        "Codex account response",
      );
    } catch (error) {
      if (error instanceof CodexAppServerError) throw error;
      throw new CodexAppServerError(
        "Codex App Server could not read the current account",
        "app-server-unavailable",
        { cause: error },
      );
    }
    const account = result["account"];
    if (!isRecord(account)) {
      throw new CodexAppServerError(
        "Codex is not signed in; sign in through the Codex CLI or desktop app",
        "chatgpt-auth-required",
      );
    }
    if (account["type"] !== "chatgpt") {
      throw new CodexAppServerError(
        "Starlight requires Codex ChatGPT sign-in; API-key and external provider accounts are not accepted",
        "chatgpt-auth-unsupported",
      );
    }
    return {
      type: "chatgpt",
      planType:
        typeof account["planType"] === "string" &&
        account["planType"].length > 0
          ? account["planType"]
          : "unknown",
    };
  }

  async imageCapabilityStatus(): Promise<CodexImageCapabilityStatus> {
    await this.accountStatus();
    if (this.workspace === null || this.installation === null) {
      throw new CodexAppServerError(
        "Codex image capability could not be inspected before startup completed",
        "app-server-unavailable",
      );
    }
    const capabilities = record(
      await this.request("modelProvider/capabilities/read", {}),
      "Codex model-provider capability response",
    );
    if (typeof capabilities["imageGeneration"] !== "boolean") {
      throw new CodexAppServerError(
        "Codex App Server returned an incompatible image capability response",
        "runtime-incompatible",
      );
    }
    if (!capabilities["imageGeneration"]) {
      return {
        available: false,
        reason: "runtime-capability-unavailable",
        skillPath: null,
        codexRuntimeVersion: this.installation.installedVersion,
      };
    }
    const listed = record(
      await this.request("skills/list", {
        cwds: [this.workspace],
        forceReload: false,
      }),
      "Codex skills response",
    );
    const data = listed["data"];
    if (!Array.isArray(data)) {
      throw new CodexAppServerError(
        "Codex App Server returned an incompatible skills response",
        "runtime-incompatible",
      );
    }
    const skills = data.flatMap((entry) => {
      if (!isRecord(entry) || !Array.isArray(entry["skills"])) return [];
      return entry["skills"].filter(isRecord);
    });
    const imagegen = skills.find(
      (skill) =>
        skill["name"] === "imagegen" &&
        skill["scope"] === "system" &&
        skill["enabled"] === true &&
        typeof skill["path"] === "string" &&
        isAbsolute(skill["path"]),
    );
    if (imagegen === undefined || typeof imagegen["path"] !== "string") {
      return {
        available: false,
        reason: "imagegen-skill-unavailable",
        skillPath: null,
        codexRuntimeVersion: this.installation.installedVersion,
      };
    }
    return {
      available: true,
      reason: "ready",
      skillPath: imagegen["path"],
      codexRuntimeVersion: this.installation.installedVersion,
    };
  }

  async imageInputCapabilityStatus(): Promise<CodexImageInputCapabilityStatus> {
    await this.accountStatus();
    const listed = record(
      await this.request("model/list", { limit: 100, includeHidden: false }),
      "Codex model list response",
    );
    const data = listed["data"];
    if (!Array.isArray(data)) {
      throw new CodexAppServerError(
        "Codex App Server returned an incompatible model list response",
        "runtime-incompatible",
      );
    }
    const models = data.filter(isRecord);
    const selected =
      models.find((model) => model["isDefault"] === true) ?? models[0];
    if (selected === undefined) {
      throw new CodexAppServerError(
        "Codex App Server returned no available model",
        "runtime-incompatible",
      );
    }
    const modalities = selected["inputModalities"];
    const available =
      modalities === undefined ||
      (Array.isArray(modalities) &&
        modalities.some((modality) => modality === "image"));
    return {
      available,
      reason: available
        ? "ready"
        : "default-model-does-not-support-image-input",
      modelId:
        typeof selected["model"] === "string"
          ? selected["model"]
          : typeof selected["id"] === "string"
            ? selected["id"]
            : null,
    };
  }

  async executionProfileStatus(): Promise<CodexExecutionProfileStatus> {
    await this.accountStatus();
    const listed = record(
      await this.request("model/list", { limit: 100, includeHidden: false }),
      "Codex model list response",
    );
    const data = listed["data"];
    if (!Array.isArray(data)) {
      throw new CodexAppServerError(
        "Codex App Server returned an incompatible model list response",
        "runtime-incompatible",
      );
    }
    const models = data.filter(isRecord);
    const selected =
      models.find((model) => model["isDefault"] === true) ?? models[0];
    if (selected === undefined) {
      throw new CodexAppServerError(
        "Codex App Server returned no available model",
        "runtime-incompatible",
      );
    }
    const supported = selected["supportedReasoningEfforts"];
    if (supported !== undefined && !Array.isArray(supported)) {
      throw new CodexAppServerError(
        "Codex App Server returned incompatible reasoning-effort capabilities",
        "runtime-incompatible",
      );
    }
    const efforts = new Set(
      (supported ?? [])
        .filter(isRecord)
        .map((entry) => entry["reasoningEffort"])
        .filter((effort): effort is string => typeof effort === "string"),
    );
    return {
      modelId:
        typeof selected["model"] === "string"
          ? selected["model"]
          : typeof selected["id"] === "string"
            ? selected["id"]
            : null,
      supportedProfiles: [
        "auto",
        ...(efforts.has("low") ? (["fast"] as const) : []),
        ...(efforts.has("high") ? (["thorough"] as const) : []),
      ],
    };
  }

  private async requireExecutionProfile(profile: AgentExecutionProfile) {
    if (profile === "auto") return;
    const status = await this.executionProfileStatus();
    if (!status.supportedProfiles.includes(profile)) {
      throw new CodexAppServerError(
        `The default Codex model does not advertise the ${profile} Starlight execution profile`,
        "execution-profile-unavailable",
      );
    }
  }

  async generateText(input: CodexTextInput) {
    await this.accountStatus();
    const executionProfile = input.executionProfile ?? "auto";
    await this.requireExecutionProfile(executionProfile);
    if (this.workspace === null)
      throw new Error("Codex driver workspace is unavailable");
    this.throwIfSecurityViolation();
    const dynamicTools = dynamicToolSpecs(input.dynamicTools);
    const behaviorInstructions = baseInstructions({
      behaviorProfileVersion:
        input.behaviorProfileVersion ??
        CREATIVE_DRIVER_BEHAVIOR_PROFILE_VERSION,
      systemImageGeneration: input.systemImageGenerationAvailable === true,
      dynamicTools: input.dynamicTools ?? [],
      workingSetSupplied: input.workingSet !== undefined,
      ...(input.driverInstructions === undefined
        ? {}
        : { serverInstructions: input.driverInstructions }),
    });
    const dynamicToolNames = new Set(dynamicTools.map((tool) => tool.name));
    const sessionKey = input.sessionId ?? input.sessionTitle;
    let threadId = this.sessionThreads.get(sessionKey);
    if (threadId === undefined) {
      const recordedThreadId =
        (await this.threadStore.read(sessionKey)) ?? undefined;
      const threadResult = record(
        await this.request(
          recordedThreadId === undefined ? "thread/start" : "thread/resume",
          {
            ...(recordedThreadId === undefined
              ? { ephemeral: false }
              : { threadId: recordedThreadId }),
            cwd: this.workspace,
            runtimeWorkspaceRoots: [this.workspace],
            approvalPolicy: "never",
            approvalsReviewer: "user",
            sandbox: "read-only",
            modelProvider: "openai",
            allowProviderModelFallback: false,
            dynamicTools,
            environments: [],
            selectedCapabilityRoots: [],
            baseInstructions: behaviorInstructions,
            developerInstructions:
              "Follow the selected Starlight behavior profile and capability manifest. Emit JSON with exactly one response string after any definitive tool results settle.",
            config: {
              features: {
                hooks: false,
                shell_tool: false,
                unified_exec: false,
                code_mode_host: false,
                apps: false,
                browser_use: false,
                computer_use: false,
                image_generation: false,
                multi_agent: false,
                in_app_browser: false,
                plugins: false,
                tool_suggest: false,
                workspace_dependencies: false,
                skill_mcp_dependency_install: false,
              },
              web_search: "live",
              notify: [],
              project_doc_max_bytes: 0,
              project_doc_fallback_filenames: [],
              skills: { include_instructions: false },
              include_permissions_instructions: false,
              include_apps_instructions: false,
              include_collaboration_mode_instructions: false,
              include_environment_context: false,
              mcp_servers: Object.fromEntries(
                this.disabledMcpServerNames.map((name) => [
                  name,
                  { enabled: false },
                ]),
              ),
              plugins: {},
            },
          },
        ),
        "Codex thread start response",
      );
      this.throwIfSecurityViolation();
      if (
        !this.hasOnlyCodexHomeInstructionSource(
          threadResult["instructionSources"],
        )
      ) {
        const violation = new CodexAppServerError(
          "Codex loaded ambient instruction files into the text-only driver",
          "security-boundary-violated",
        );
        this.recordSecurityViolation(violation);
        throw violation;
      }
      const thread = record(threadResult["thread"], "Codex thread");
      threadId = text(thread["id"], "Codex thread ID");
      if (recordedThreadId !== undefined && threadId !== recordedThreadId) {
        throw new CodexAppServerError(
          "Codex resumed a different thread than the recorded Starlight session",
          "security-boundary-violated",
        );
      }
      this.sessionThreads.set(sessionKey, threadId);
      await this.threadStore.write(sessionKey, threadId);
    }
    const current = input.messages.at(-1);
    if (current?.role !== "user") {
      throw new Error(
        "Starlight turn context must end with the current user message",
      );
    }
    const currentInput = await this.materializeInput(current);
    let turnResult: JsonRecord;
    this.activeCapability = "text";
    this.turnStartCallbacks = input.callbacks ?? null;
    this.turnStartDynamicTools = { threadId, names: dynamicToolNames };
    this.turnStartInFlight = true;
    try {
      turnResult = record(
        await this.request("turn/start", {
          threadId,
          input: currentInput,
          additionalContext: {
            starlightSession: {
              kind: "untrusted",
              value: `Session title: ${input.sessionTitle}\n\n${transcript(input.messages)}`,
            },
            ...workingSetContext(input.workingSet),
            ...mediaExecutionContext(input.workingSet),
          },
          clientUserMessageId: input.clientUserMessageId ?? input.turnId,
          approvalPolicy: "never",
          cwd: this.workspace,
          runtimeWorkspaceRoots: [this.workspace],
          environments: [],
          ...(profileEffort(executionProfile) === undefined
            ? {}
            : { effort: profileEffort(executionProfile) }),
          sandboxPolicy: { type: "readOnly", networkAccess: false },
          outputSchema: {
            type: "object",
            properties: {
              response: { type: "string", minLength: 1, maxLength: 20_000 },
            },
            required: ["response"],
            additionalProperties: false,
          },
          responsesapiClientMetadata: {
            integration: "starlight",
            starlight_turn_id: input.turnId,
          },
        }),
        "Codex turn start response",
      );
    } catch (error) {
      this.activeCapability = null;
      this.turnStartCallbacks = null;
      this.turnStartDynamicTools = null;
      if (
        error instanceof CodexAppServerError &&
        error.code === "security-boundary-violated"
      ) {
        throw error;
      }
      throw new CodexAppServerError(
        "Codex App Server did not return a definitive turn-start outcome",
        "turn-outcome-ambiguous",
        { cause: error },
      );
    } finally {
      this.turnStartInFlight = false;
    }
    const startedTurn = record(turnResult["turn"], "Codex started turn");
    const turnId = text(startedTurn["id"], "Codex turn ID");
    this.activeTurn = { threadId, turnId };
    if (input.callbacks !== undefined)
      this.turnCallbacks.set(turnId, input.callbacks);
    if (dynamicToolNames.size > 0)
      this.turnDynamicToolNames.set(turnId, dynamicToolNames);
    this.turnStartCallbacks = null;
    this.turnStartDynamicTools = null;
    try {
      this.throwIfSecurityViolation();
      const completed = await this.waitForTurn(turnId);
      await this.drainTurnCallbacks(turnId);
      this.throwIfSecurityViolation();
      return finalText(completed, dynamicTools.length > 0);
    } catch (error) {
      if (
        error instanceof CodexAppServerError &&
        error.code === "security-boundary-violated"
      ) {
        this.recordSecurityViolation(error);
      }
      throw error;
    } finally {
      this.turnCallbacks.delete(turnId);
      this.turnDynamicToolNames.delete(turnId);
      this.turnCallbackTasks.delete(turnId);
      this.turnCallbackErrors.delete(turnId);
      for (const key of this.dynamicToolCalls.keys()) {
        if (key.startsWith(`${turnId}:`)) this.dynamicToolCalls.delete(key);
      }
      this.turnErrors.delete(turnId);
      this.turnModeration.delete(turnId);
      this.activeTurn = null;
      this.activeCapability = null;
    }
  }

  async generateImage(input: CodexImageInput): Promise<CodexCapableTurnResult> {
    const capability = await this.imageCapabilityStatus();
    if (!capability.available || capability.skillPath === null) {
      throw new CodexAppServerError(
        capability.reason === "runtime-capability-unavailable"
          ? "This Codex App Server does not advertise image generation"
          : "The supported system imagegen skill is unavailable",
        "image-capability-unavailable",
      );
    }
    const executionProfile = input.executionProfile ?? "auto";
    await this.requireExecutionProfile(executionProfile);
    if (this.workspace === null)
      throw new Error("Codex driver workspace is unavailable");
    this.throwIfSecurityViolation();
    const dynamicTools = dynamicToolSpecs(input.dynamicTools);
    const behaviorInstructions = baseInstructions({
      behaviorProfileVersion:
        input.behaviorProfileVersion ??
        CREATIVE_DRIVER_BEHAVIOR_PROFILE_VERSION,
      systemImageGeneration: true,
      dynamicTools: input.dynamicTools ?? [],
      workingSetSupplied: input.workingSet !== undefined,
      ...(input.driverInstructions === undefined
        ? {}
        : { serverInstructions: input.driverInstructions }),
    });
    const dynamicToolNames = new Set(dynamicTools.map((tool) => tool.name));
    const current = input.messages.at(-1);
    if (current?.role !== "user") {
      throw new CodexAppServerError(
        "Starlight image input must end with one supported text prompt",
        "image-input-unsupported",
      );
    }
    const sessionKey = input.sessionId ?? input.sessionTitle;
    let threadId = this.sessionThreads.get(sessionKey);
    let resumeRecordedThread = false;
    if (threadId === undefined) {
      threadId = (await this.threadStore.read(sessionKey)) ?? undefined;
      resumeRecordedThread = threadId !== undefined;
    }
    if (threadId === undefined) {
      const threadResult = record(
        await this.request("thread/start", {
          cwd: this.workspace,
          runtimeWorkspaceRoots: [this.workspace],
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandbox: "workspace-write",
          modelProvider: "openai",
          allowProviderModelFallback: false,
          ephemeral: false,
          dynamicTools,
          environments: [],
          baseInstructions: behaviorInstructions,
          developerInstructions:
            "Follow the selected Starlight behavior profile and capability manifest. Continue one coherent conversation and preserve definitive image or application-tool results.",
          config: {
            features: {
              hooks: false,
              shell_tool: false,
              unified_exec: false,
              code_mode_host: false,
              apps: false,
              browser_use: false,
              computer_use: false,
              image_generation: true,
              multi_agent: false,
              in_app_browser: false,
              plugins: false,
              tool_suggest: false,
              workspace_dependencies: false,
              skill_mcp_dependency_install: false,
            },
            web_search: "live",
            notify: [],
            project_doc_max_bytes: 0,
            project_doc_fallback_filenames: [],
            skills: { include_instructions: true },
            include_permissions_instructions: false,
            include_apps_instructions: false,
            include_collaboration_mode_instructions: false,
            include_environment_context: false,
            mcp_servers: Object.fromEntries(
              this.disabledMcpServerNames.map((name) => [
                name,
                { enabled: false },
              ]),
            ),
            plugins: {},
          },
        }),
        "Codex capable thread start response",
      );
      this.throwIfSecurityViolation();
      if (
        !this.hasOnlyCodexHomeInstructionSource(
          threadResult["instructionSources"],
        )
      ) {
        const violation = new CodexAppServerError(
          "Codex loaded ambient instruction files into the capable driver",
          "security-boundary-violated",
        );
        this.recordSecurityViolation(violation);
        throw violation;
      }
      const thread = record(threadResult["thread"], "Codex capable thread");
      threadId = text(thread["id"], "Codex capable thread ID");
      this.sessionThreads.set(sessionKey, threadId);
      await this.threadStore.write(sessionKey, threadId);
    } else if (resumeRecordedThread) {
      const threadResult = record(
        await this.request("thread/resume", {
          threadId,
          cwd: this.workspace,
          runtimeWorkspaceRoots: [this.workspace],
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandbox: "workspace-write",
          modelProvider: "openai",
          allowProviderModelFallback: false,
          dynamicTools,
          environments: [],
          baseInstructions: behaviorInstructions,
          developerInstructions:
            "Follow the selected Starlight behavior profile and capability manifest. Continue one coherent conversation and preserve definitive image or application-tool results.",
          config: {
            features: {
              hooks: false,
              shell_tool: false,
              unified_exec: false,
              code_mode_host: false,
              apps: false,
              browser_use: false,
              computer_use: false,
              image_generation: true,
              multi_agent: false,
              in_app_browser: false,
              plugins: false,
              tool_suggest: false,
              workspace_dependencies: false,
              skill_mcp_dependency_install: false,
            },
            web_search: "live",
            notify: [],
            project_doc_max_bytes: 0,
            project_doc_fallback_filenames: [],
            skills: { include_instructions: true },
            include_permissions_instructions: false,
            include_apps_instructions: false,
            include_collaboration_mode_instructions: false,
            include_environment_context: false,
            mcp_servers: Object.fromEntries(
              this.disabledMcpServerNames.map((name) => [
                name,
                { enabled: false },
              ]),
            ),
            plugins: {},
          },
        }),
        "Codex capable thread resume response",
      );
      this.throwIfSecurityViolation();
      if (
        !this.hasOnlyCodexHomeInstructionSource(
          threadResult["instructionSources"],
        )
      ) {
        const violation = new CodexAppServerError(
          "Codex loaded ambient instruction files into the capable driver",
          "security-boundary-violated",
        );
        this.recordSecurityViolation(violation);
        throw violation;
      }
      const thread = record(
        threadResult["thread"],
        "Codex resumed capable thread",
      );
      const resumedThreadId = text(
        thread["id"],
        "Codex resumed capable thread ID",
      );
      if (resumedThreadId !== threadId) {
        throw new CodexAppServerError(
          "Codex resumed a different thread than the recorded Starlight session",
          "security-boundary-violated",
        );
      }
      this.sessionThreads.set(sessionKey, threadId);
    }
    const currentInput = await this.materializeInput(current);
    let turnResult: JsonRecord;
    this.activeCapability = "image";
    this.turnStartCallbacks = input.callbacks ?? null;
    this.turnStartDynamicTools = { threadId, names: dynamicToolNames };
    this.turnStartInFlight = true;
    try {
      turnResult = record(
        await this.request("turn/start", {
          threadId,
          input: currentInput,
          additionalContext: {
            starlightSession: {
              kind: "untrusted",
              value: `Session title: ${input.sessionTitle}\n\n${transcript(input.messages)}`,
            },
            ...workingSetContext(input.workingSet),
            ...mediaExecutionContext(input.workingSet),
          },
          clientUserMessageId: input.clientUserMessageId ?? input.turnId,
          approvalPolicy: "never",
          cwd: this.workspace,
          runtimeWorkspaceRoots: [this.workspace],
          environments: [],
          ...(profileEffort(executionProfile) === undefined
            ? {}
            : { effort: profileEffort(executionProfile) }),
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: [this.workspace],
            networkAccess: false,
            excludeSlashTmp: true,
            excludeTmpdirEnvVar: true,
          },
          responsesapiClientMetadata: {
            integration: "starlight",
            starlight_turn_id: input.turnId,
            starlight_capability: "text-and-image",
          },
        }),
        "Codex image turn start response",
      );
    } catch (error) {
      this.activeCapability = null;
      this.turnStartCallbacks = null;
      this.turnStartDynamicTools = null;
      if (
        error instanceof CodexAppServerError &&
        error.code === "security-boundary-violated"
      ) {
        throw error;
      }
      throw new CodexAppServerError(
        "Codex App Server did not return a definitive image turn-start outcome",
        "turn-outcome-ambiguous",
        { cause: error },
      );
    } finally {
      this.turnStartInFlight = false;
    }
    const startedTurn = record(turnResult["turn"], "Codex started image turn");
    const turnId = text(startedTurn["id"], "Codex image turn ID");
    this.activeTurn = { threadId, turnId };
    if (input.callbacks !== undefined)
      this.turnCallbacks.set(turnId, input.callbacks);
    if (dynamicToolNames.size > 0)
      this.turnDynamicToolNames.set(turnId, dynamicToolNames);
    this.turnStartCallbacks = null;
    this.turnStartDynamicTools = null;
    try {
      this.throwIfSecurityViolation();
      const completed = await this.waitForTurn(turnId);
      await this.drainTurnCallbacks(turnId);
      this.throwIfSecurityViolation();
      const summary = capableTurnSummary(completed, dynamicTools.length > 0);
      const images = await Promise.all(
        summary.imageItems
          .filter((item) => item["status"] === "completed")
          .map(async (item) => {
            const itemId = text(item["id"], "Codex image item ID");
            return (
              this.completedImageResults.get(`${turnId}:${itemId}`) ??
              (await this.readImageItem(item, capability.codexRuntimeVersion))
            );
          }),
      );
      const attempts: CodexImageAttempt[] = summary.imageItems.map((item) => ({
        codexItemId: text(item["id"], "Codex image item ID"),
        status:
          typeof item["status"] === "string" && item["status"].trim().length > 0
            ? item["status"].trim().slice(0, 80)
            : "unknown",
        revisedPrompt:
          typeof item["revisedPrompt"] === "string" &&
          item["revisedPrompt"].trim().length > 0
            ? item["revisedPrompt"].trim()
            : null,
        result:
          item["status"] === "completed"
            ? typeof item["savedPath"] === "string"
              ? "Image saved by Codex."
              : "Image bytes returned by Codex."
            : typeof item["result"] === "string"
              ? sanitizedLine(item["result"])
              : "",
      }));
      const startedCount =
        typeof completed["starlightImageGenerationStartCount"] === "number"
          ? completed["starlightImageGenerationStartCount"]
          : attempts.length;
      for (let index = attempts.length; index < startedCount; index += 1) {
        attempts.push({
          codexItemId: `unreported_image_attempt_${String(index + 1)}`,
          status: "outcome-unreported",
          revisedPrompt: null,
          result:
            "Codex reported an image attempt start without a terminal image item.",
        });
      }
      if (
        attempts.some(
          (attempt) =>
            attempt.status !== "completed" && attempt.status !== "failed",
        )
      ) {
        throw new CodexAppServerError(
          "Codex completed without a definitive outcome for every image attempt",
          "turn-outcome-ambiguous",
        );
      }
      const moderation = this.turnModeration.get(turnId) ?? [];
      this.turnModeration.delete(turnId);
      this.turnErrors.delete(turnId);
      return {
        text: summary.response,
        images,
        attempts,
        moderation,
      };
    } catch (error) {
      if (
        error instanceof CodexAppServerError &&
        error.code === "security-boundary-violated"
      ) {
        this.recordSecurityViolation(error);
      }
      throw error;
    } finally {
      this.turnCallbacks.delete(turnId);
      this.turnDynamicToolNames.delete(turnId);
      this.turnCallbackTasks.delete(turnId);
      this.turnCallbackErrors.delete(turnId);
      for (const key of this.dynamicToolCalls.keys()) {
        if (key.startsWith(`${turnId}:`)) this.dynamicToolCalls.delete(key);
      }
      this.turnErrors.delete(turnId);
      this.turnModeration.delete(turnId);
      for (const key of this.completedImageResults.keys()) {
        if (key.startsWith(`${turnId}:`))
          this.completedImageResults.delete(key);
      }
      this.activeTurn = null;
      this.activeCapability = null;
    }
  }

  async steer(input: {
    readonly text: string;
    readonly parts?: readonly CodexMessagePart[];
  }): Promise<CodexSteerResult> {
    const active = this.activeTurn;
    if (active === null) return { status: "not-active", turnId: null };
    const items = await this.materializeInput({
      role: "user",
      text: input.text,
      ...(input.parts === undefined ? {} : { parts: input.parts }),
    });
    let result: JsonRecord;
    try {
      result = record(
        await this.request("turn/steer", {
          threadId: active.threadId,
          expectedTurnId: active.turnId,
          input: items,
        }),
        "Codex steer response",
      );
    } catch (error) {
      if (error instanceof CodexRpcError) {
        return {
          status: error.rpcCode === -32_601 ? "unsupported" : "cannot-apply",
          turnId: null,
        };
      }
      throw new CodexAppServerError(
        "Codex steering did not return a definitive outcome",
        "turn-outcome-ambiguous",
        { cause: error },
      );
    }
    const turnId = text(result["turnId"], "Codex steered turn ID");
    if (turnId !== active.turnId) {
      throw new CodexAppServerError(
        "Codex applied steering to an unexpected turn",
        "security-boundary-violated",
      );
    }
    return { status: "applied", turnId };
  }

  private async materializeInput(
    message: CodexTextInput["messages"][number],
  ): Promise<readonly JsonRecord[]> {
    if (this.workspace === null)
      throw new Error("Codex driver workspace is unavailable");
    const parts = message.parts ?? [
      { type: "text" as const, text: message.text },
    ];
    if (parts.length < 1 || parts.length > 32) {
      throw new CodexAppServerError(
        "Codex input parts are invalid",
        "image-input-unsupported",
      );
    }
    const input: JsonRecord[] = [];
    for (const part of parts) {
      if (part.type === "text") {
        if (part.text.trim().length < 1) {
          throw new CodexAppServerError(
            "Codex text input part is empty",
            "image-input-unsupported",
          );
        }
        input.push({ type: "text", text: part.text });
        continue;
      }
      const attachment = part.attachment;
      if (
        attachment.bytes.byteLength < 1 ||
        attachment.bytes.byteLength > 20 * 1024 * 1024
      ) {
        throw new CodexAppServerError(
          "Codex image input has an invalid file size",
          "image-input-unsupported",
        );
      }
      const extension =
        attachment.mimeType === "image/png"
          ? "png"
          : attachment.mimeType === "image/jpeg"
            ? "jpg"
            : "webp";
      const safeId = attachment.attachmentId
        .replaceAll(/[^A-Za-z0-9_-]/gu, "_")
        .slice(0, 160);
      const root = join(this.workspace, "input-images");
      await mkdir(root, { recursive: true, mode: 0o700 });
      const path = join(root, `${safeId}.${extension}`);
      await writeFile(path, attachment.bytes, { mode: 0o600 });
      input.push({ type: "localImage", path });
    }
    return input;
  }

  private queueTurnCallback(turnId: string, callback: () => Promise<void>) {
    const prior = this.turnCallbackTasks.get(turnId) ?? Promise.resolve();
    const next = prior.then(callback).catch((error: unknown) => {
      const failure =
        error instanceof Error ? error : new Error("Codex callback failed");
      this.turnCallbackErrors.set(turnId, failure);
      const active = this.activeTurn;
      if (active?.turnId === turnId) {
        void this.request("turn/interrupt", active).catch(() => undefined);
      }
    });
    this.turnCallbackTasks.set(turnId, next);
  }

  private async drainTurnCallbacks(turnId: string) {
    await this.turnCallbackTasks.get(turnId);
    const error = this.turnCallbackErrors.get(turnId);
    if (error !== undefined) throw error;
  }

  private async readImageItem(
    item: JsonRecord,
    codexRuntimeVersion: string,
  ): Promise<CodexImageResult> {
    if (this.workspace === null)
      throw new Error("Codex driver workspace is unavailable");
    const itemId = text(item["id"], "Codex image item ID");
    const savedPath =
      typeof item["savedPath"] === "string" &&
      item["savedPath"].trim().length > 0
        ? item["savedPath"].trim()
        : null;
    let bytes: Uint8Array;
    let fileName: string;
    if (savedPath === null) {
      const result = text(item["result"], "Codex image result").trim();
      if (
        result.length > 90 * 1024 * 1024 ||
        !/^[A-Za-z0-9+/]+={0,2}$/u.test(result) ||
        result.length % 4 !== 0
      ) {
        throw new CodexAppServerError(
          "Codex image result is not bounded base64 media",
          "image-output-missing",
        );
      }
      bytes = Uint8Array.from(Buffer.from(result, "base64"));
      fileName = `${itemId}.png`;
    } else {
      const workspacePath = await realpath(this.workspace);
      const resolvedPath = resolve(savedPath);
      if (!isAbsolute(savedPath)) {
        throw new CodexAppServerError(
          "Codex image output path is not absolute",
          "security-boundary-violated",
        );
      }
      const outputPath = await realpath(resolvedPath).catch((error) => {
        throw new CodexAppServerError(
          "Codex image output is missing from the bounded image roots",
          "image-output-missing",
          { cause: error },
        );
      });
      const allowedRoots = [workspacePath];
      const codexHome = configuredCodexHome(this.environment);
      if (codexHome !== null) {
        const resolvedCodexHome = await realpath(codexHome).catch(() => null);
        const generatedImagesRoot = await realpath(
          join(codexHome, "generated_images"),
        ).catch(() => null);
        if (
          resolvedCodexHome !== null &&
          generatedImagesRoot !== null &&
          isNestedPath(resolvedCodexHome, generatedImagesRoot)
        ) {
          allowedRoots.push(generatedImagesRoot);
        }
      }
      if (!allowedRoots.some((root) => isNestedPath(root, outputPath))) {
        throw new CodexAppServerError(
          "Codex image output escaped the bounded image roots",
          "security-boundary-violated",
        );
      }
      const outputStat = await stat(outputPath);
      if (
        !outputStat.isFile() ||
        outputStat.size < 1 ||
        outputStat.size > 64 * 1024 * 1024
      ) {
        throw new CodexAppServerError(
          "Codex image output has an invalid file size",
          "image-output-missing",
        );
      }
      bytes = Uint8Array.from(await readFile(outputPath));
      fileName = basename(outputPath);
    }
    if (bytes.byteLength < 1 || bytes.byteLength > 64 * 1024 * 1024) {
      throw new CodexAppServerError(
        "Codex image output has an invalid file size",
        "image-output-missing",
      );
    }
    const revisedPrompt =
      typeof item["revisedPrompt"] === "string" &&
      item["revisedPrompt"].trim().length > 0
        ? item["revisedPrompt"].trim()
        : null;
    return {
      bytes,
      fileName,
      declaredMediaType: imageMediaType(bytes),
      codexItemId: itemId,
      revisedPrompt,
      model: "gpt-image-2",
      tool: "image_generation",
      codexRuntimeVersion,
    };
  }

  private throwIfSecurityViolation() {
    if (this.securityViolation !== null) throw this.securityViolation;
  }

  private hasOnlyCodexHomeInstructionSource(value: unknown) {
    if (value === undefined) return true;
    return Array.isArray(value) && value.length === 0;
  }

  private processFailure(detail: string, cause?: unknown) {
    const ambiguous = this.activeTurn !== null || this.turnStartInFlight;
    const phase = this.initialized
      ? "became unavailable"
      : "failed during startup";
    return new CodexAppServerError(
      ambiguous
        ? `${detail}; the Codex turn outcome is ambiguous`
        : `${detail}; the local Codex runtime ${phase}`,
      ambiguous ? "turn-outcome-ambiguous" : "app-server-unavailable",
      cause === undefined ? {} : { cause },
    );
  }

  private async waitForTurn(turnId: string) {
    const completed = this.completedTurns.get(turnId);
    if (completed !== undefined) {
      this.completedTurns.delete(turnId);
      return completed;
    }
    return await new Promise<JsonRecord>((resolve, reject) => {
      const pending: PendingTurn = {
        turnId,
        resolve,
        reject,
        timeout: setTimeout(() => undefined, 0),
        hardDeadlineAt: Date.now() + this.turnAbsoluteTimeoutMs,
      };
      clearTimeout(pending.timeout);
      this.pendingTurns.set(turnId, pending);
      this.armTurnTimeout(pending);
    });
  }

  private armTurnTimeout(pending: PendingTurn) {
    clearTimeout(pending.timeout);
    const hardRemaining = pending.hardDeadlineAt - Date.now();
    const duration = Math.max(0, Math.min(this.turnTimeoutMs, hardRemaining));
    pending.timeout = setTimeout(() => {
      if (this.pendingTurns.get(pending.turnId) !== pending) return;
      this.pendingTurns.delete(pending.turnId);
      const capability =
        this.activeCapability === "image" ? "image turn" : "turn";
      pending.reject(
        new CodexAppServerError(
          hardRemaining <= this.turnTimeoutMs
            ? `Codex App Server ${capability} reached its absolute execution limit without a terminal notification`
            : `Codex App Server ${capability} stopped reporting progress before a terminal notification`,
          "turn-outcome-ambiguous",
        ),
      );
    }, duration);
  }

  private refreshTurnTimeout(turnId: string) {
    const pending = this.pendingTurns.get(turnId);
    if (pending !== undefined) this.armTurnTimeout(pending);
  }

  private async request(method: string, params: unknown) {
    const child = this.process;
    if (child === null || child.stdin.destroyed) {
      throw new Error("Codex App Server is not running");
    }
    const id = this.requestId;
    this.requestId += 1;
    return await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Codex App Server ${method} request timed out`));
      }, this.requestTimeoutMs);
      this.pendingRequests.set(id, { method, resolve, reject, timeout });
      child.stdin.write(
        `${JSON.stringify({ method, id, params })}\n`,
        (error) => {
          if (error === null || error === undefined) return;
          clearTimeout(timeout);
          this.pendingRequests.delete(id);
          reject(
            new Error(
              `Codex App Server ${method} request could not be written`,
              { cause: error },
            ),
          );
        },
      );
    });
  }

  private notify(method: string, params: unknown) {
    const child = this.process;
    if (child === null || child.stdin.destroyed) {
      throw new Error("Codex App Server is not running");
    }
    child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private serverResponse(
    id: number | string,
    response:
      | { readonly result: Readonly<Record<string, unknown>> }
      | { readonly error: Readonly<Record<string, unknown>> },
  ) {
    const child = this.process;
    if (child === null || child.stdin.destroyed) return;
    child.stdin.write(`${JSON.stringify({ id, ...response })}\n`);
  }

  private handleDynamicToolCall(id: number | string, message: JsonRecord) {
    const params = isRecord(message["params"]) ? message["params"] : null;
    const threadId = params?.["threadId"];
    const turnId = params?.["turnId"];
    const callId = params?.["callId"];
    const tool = params?.["tool"];
    const namespace = params?.["namespace"];
    const args = params?.["arguments"];
    const active = this.activeTurn;
    const starting = this.turnStartInFlight ? this.turnStartDynamicTools : null;
    const activeContext =
      typeof threadId === "string" &&
      typeof turnId === "string" &&
      active?.threadId === threadId &&
      active.turnId === turnId;
    const startContext =
      typeof threadId === "string" &&
      typeof turnId === "string" &&
      starting?.threadId === threadId;
    const names =
      typeof turnId === "string"
        ? (this.turnDynamicToolNames.get(turnId) ??
          (startContext ? starting?.names : undefined))
        : undefined;
    const callbacks =
      typeof turnId === "string"
        ? (this.turnCallbacks.get(turnId) ??
          (startContext ? this.turnStartCallbacks : null))
        : null;
    if (
      params === null ||
      (!activeContext && !startContext) ||
      typeof threadId !== "string" ||
      typeof turnId !== "string" ||
      typeof callId !== "string" ||
      callId.length < 1 ||
      callId.length > 200 ||
      typeof tool !== "string" ||
      namespace !== null ||
      !isRecord(args) ||
      JSON.stringify(args).length > 32_000 ||
      names === undefined ||
      !names.has(tool) ||
      callbacks?.onDynamicToolCall === undefined
    ) {
      this.rejectServerRequest(id, "item/tool/call");
      return;
    }
    this.refreshTurnTimeout(turnId);
    if (!this.turnDynamicToolNames.has(turnId))
      this.turnDynamicToolNames.set(turnId, names);
    if (!this.turnCallbacks.has(turnId) && callbacks !== null) {
      this.turnCallbacks.set(turnId, callbacks);
    }
    const key = `${turnId}:${callId}`;
    let task = this.dynamicToolCalls.get(key);
    if (task === undefined) {
      const callback = callbacks.onDynamicToolCall;
      const prior = this.turnCallbackTasks.get(turnId) ?? Promise.resolve();
      task = prior.then(
        async () =>
          await callback({
            toolName: tool as AgentDriverToolName,
            callId,
            arguments: args,
            threadId,
            turnId,
          }),
      );
      this.dynamicToolCalls.set(key, task);
      const tracked = task
        .then(() => undefined)
        .catch((error: unknown) => {
          const failure =
            error instanceof Error
              ? error
              : new Error("Codex tool callback failed");
          this.turnCallbackErrors.set(turnId, failure);
          const current = this.activeTurn;
          if (current?.turnId === turnId) {
            void this.request("turn/interrupt", current).catch(() => undefined);
          }
        });
      this.turnCallbackTasks.set(turnId, tracked);
    }
    void task.then(
      (result) => {
        this.serverResponse(id, {
          result: {
            success: result.success,
            contentItems: [
              { type: "inputText", text: result.text.slice(0, 4_000) },
            ],
          },
        });
      },
      () => {
        this.serverResponse(id, {
          result: {
            success: false,
            contentItems: [
              {
                type: "inputText",
                text: "Starlight could not confirm the durable media-tool outcome. Do not retry this call.",
              },
            ],
          },
        });
      },
    );
  }

  private receiveLine(line: string) {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      this.recordSecurityViolation(
        new CodexAppServerError(
          "Codex App Server emitted invalid JSONL",
          "security-boundary-violated",
        ),
      );
      return;
    }
    if (!isRecord(value)) {
      this.recordSecurityViolation(
        new CodexAppServerError(
          "Codex App Server emitted an invalid protocol message",
          "security-boundary-violated",
        ),
      );
      return;
    }
    const message = value;
    if (typeof message["id"] === "number" && message["method"] === undefined) {
      const pending = this.pendingRequests.get(message["id"]);
      if (pending === undefined) return;
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(message["id"]);
      if (message["error"] !== undefined) {
        const error = isRecord(message["error"]) ? message["error"] : {};
        pending.reject(
          new CodexRpcError(
            `Codex App Server ${pending.method} failed: ${String(error["message"] ?? "unknown error")}`,
            typeof error["code"] === "number" ? error["code"] : null,
          ),
        );
      } else {
        pending.resolve(message["result"]);
      }
      return;
    }
    if (
      (typeof message["id"] === "number" ||
        typeof message["id"] === "string") &&
      message["method"] === "item/tool/call"
    ) {
      this.handleDynamicToolCall(message["id"], message);
      return;
    }
    if (
      (typeof message["id"] === "number" ||
        typeof message["id"] === "string") &&
      typeof message["method"] === "string"
    ) {
      this.rejectServerRequest(message["id"], message["method"]);
      return;
    }
    const method = message["method"];
    const params = isRecord(message["params"]) ? message["params"] : {};
    if (method === "error") {
      const turnId = params["turnId"];
      const error = isRecord(params["error"]) ? params["error"] : null;
      if (
        typeof turnId === "string" &&
        typeof error?.["message"] === "string"
      ) {
        const errors = this.turnErrors.get(turnId) ?? [];
        errors.push(sanitizedLine(error["message"]));
        this.turnErrors.set(turnId, errors.slice(-8));
      }
      return;
    }
    if (method === "turn/moderationMetadata") {
      const turnId = params["turnId"];
      if (typeof turnId === "string") {
        const metadata = sanitizedLine(
          JSON.stringify(params["metadata"] ?? {}),
        );
        const entries = this.turnModeration.get(turnId) ?? [];
        entries.push(metadata);
        this.turnModeration.set(turnId, entries.slice(-8));
      }
      return;
    }
    if (method === "turn/completed") {
      const turn = isRecord(params["turn"]) ? params["turn"] : null;
      const turnId = typeof turn?.["id"] === "string" ? turn["id"] : null;
      const pending =
        turnId === null ? undefined : this.pendingTurns.get(turnId);
      if (turnId === null || turn === null) return;
      const completedItems = this.completedItems.get(turnId);
      this.completedItems.delete(turnId);
      const imageGenerationStartCount =
        this.imageGenerationStarts.get(turnId) ?? 0;
      this.imageGenerationStarts.delete(turnId);
      for (const key of this.imageGenerationAttempts.keys()) {
        if (key.startsWith(`${turnId}:`))
          this.imageGenerationAttempts.delete(key);
      }
      const terminalTurn: JsonRecord =
        completedItems === undefined ||
        (Array.isArray(turn["items"]) && turn["items"].length > 0)
          ? {
              ...turn,
              starlightImageGenerationStartCount: imageGenerationStartCount,
            }
          : {
              ...turn,
              items: completedItems,
              starlightImageGenerationStartCount: imageGenerationStartCount,
            };
      const errors = this.turnErrors.get(turnId);
      const completedWithError =
        terminalTurn["error"] === null &&
        errors !== undefined &&
        errors.length > 0 &&
        terminalTurn["status"] !== "completed"
          ? { ...terminalTurn, error: { message: errors.at(-1) } }
          : terminalTurn;
      if (pending === undefined) {
        this.completedTurns.set(turnId, completedWithError);
        while (this.completedTurns.size > 8) {
          const oldest = this.completedTurns.keys().next().value as
            string | undefined;
          if (oldest === undefined) break;
          this.completedTurns.delete(oldest);
        }
        return;
      }
      clearTimeout(pending.timeout);
      this.pendingTurns.delete(pending.turnId);
      pending.resolve(completedWithError);
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      const item = isRecord(params["item"]) ? params["item"] : null;
      const type = item?.["type"];
      const turnId = params["turnId"];
      const dynamicToolsAllowed =
        typeof turnId === "string" &&
        (this.turnDynamicToolNames.has(turnId) ||
          (this.turnStartInFlight &&
            this.turnStartDynamicTools !== null &&
            this.turnStartDynamicTools.names.size > 0));
      const allowedTypes =
        this.activeCapability === "image"
          ? new Set([
              "userMessage",
              "agentMessage",
              "reasoning",
              "webSearch",
              "imageGeneration",
              ...(dynamicToolsAllowed ? ["dynamicToolCall"] : []),
            ])
          : new Set([
              "userMessage",
              "agentMessage",
              "reasoning",
              "webSearch",
              ...(dynamicToolsAllowed ? ["dynamicToolCall"] : []),
            ]);
      if (typeof type === "string" && !allowedTypes.has(type)) {
        this.recordSecurityViolation(
          new CodexAppServerError(
            `Codex attempted disallowed ${type} activity in the ${
              this.activeCapability === "image" ? "image" : "text-only"
            } driver`,
            "security-boundary-violated",
          ),
        );
      }
      if (type === "webSearch" && typeof turnId === "string") {
        this.refreshTurnTimeout(turnId);
      }
      if (
        method === "item/started" &&
        type === "imageGeneration" &&
        typeof turnId === "string"
      ) {
        this.refreshTurnTimeout(turnId);
        const attempt = (this.imageGenerationStarts.get(turnId) ?? 0) + 1;
        this.imageGenerationStarts.set(turnId, attempt);
        const itemId = typeof item?.["id"] === "string" ? item["id"] : null;
        if (itemId !== null) {
          this.imageGenerationAttempts.set(`${turnId}:${itemId}`, attempt);
          const callback = (
            this.turnCallbacks.get(turnId) ?? this.turnStartCallbacks
          )?.onImageGenerationStarted;
          if (callback !== undefined) {
            this.queueTurnCallback(
              turnId,
              async () => await callback({ itemId, attempt }),
            );
          }
        }
      }
      if (
        method === "item/completed" &&
        type === "agentMessage" &&
        item !== null &&
        item["phase"] === "commentary" &&
        typeof turnId === "string"
      ) {
        this.refreshTurnTimeout(turnId);
        const itemId =
          typeof item["id"] === "string" && item["id"].trim().length > 0
            ? item["id"].trim().slice(0, 400)
            : null;
        const commentary = sanitizedCommentary(item["text"]);
        const callback = (
          this.turnCallbacks.get(turnId) ?? this.turnStartCallbacks
        )?.onCommentary;
        if (itemId !== null && commentary !== null && callback !== undefined) {
          this.queueTurnCallback(turnId, async () => {
            await callback({ itemId, text: commentary });
          });
        }
      }
      if (
        method === "item/completed" &&
        type === "imageGeneration" &&
        typeof turnId === "string" &&
        typeof item?.["id"] === "string"
      ) {
        this.refreshTurnTimeout(turnId);
        const itemId = item["id"];
        const attempt =
          this.imageGenerationAttempts.get(`${turnId}:${itemId}`) ??
          this.imageGenerationStarts.get(turnId) ??
          1;
        const callback = (
          this.turnCallbacks.get(turnId) ?? this.turnStartCallbacks
        )?.onImageGenerationCompleted;
        if (callback !== undefined) {
          const status =
            typeof item["status"] === "string" && item["status"].length > 0
              ? item["status"]
              : "unknown";
          this.queueTurnCallback(turnId, async () => {
            const installedVersion = this.installation?.installedVersion;
            const image =
              status === "completed" && installedVersion !== undefined
                ? await this.readImageItem(item, installedVersion)
                : null;
            if (image !== null) {
              this.completedImageResults.set(`${turnId}:${itemId}`, image);
            }
            await callback({ itemId, attempt, status, image });
          });
        }
      }
      if (
        method === "item/completed" &&
        item !== null &&
        (type === "agentMessage" ||
          type === "imageGeneration" ||
          type === "webSearch") &&
        typeof turnId === "string"
      ) {
        const items = this.completedItems.get(turnId) ?? [];
        items.push(item);
        this.completedItems.set(turnId, items);
        while (this.completedItems.size > 8) {
          const oldest = this.completedItems.keys().next().value as
            string | undefined;
          if (oldest === undefined) break;
          this.completedItems.delete(oldest);
        }
      }
      return;
    }
    if (
      method === "hook/started" ||
      method === "hook/completed" ||
      method === "mcpServer/startupStatus/updated"
    ) {
      this.recordSecurityViolation(
        new CodexAppServerError(
          "Codex attempted ambient hook or MCP activity in the local driver",
          "security-boundary-violated",
        ),
      );
    }
  }

  private rejectServerRequest(id: number | string, method: string) {
    const child = this.process;
    if (child === null || child.stdin.destroyed) return;
    const violation = new CodexAppServerError(
      `Codex requested disallowed host interaction through ${method}`,
      "security-boundary-violated",
    );
    const result =
      method.includes("requestApproval") || method.includes("approval")
        ? { decision: "cancel" }
        : method.includes("elicitation")
          ? { action: "cancel" }
          : method.includes("requestUserInput")
            ? { answers: {} }
            : null;
    this.serverResponse(
      id,
      result === null
        ? { error: { code: -32_601, message: "Host interaction is disabled" } }
        : { result },
    );
    this.recordSecurityViolation(violation);
  }

  private recordSecurityViolation(error: CodexAppServerError) {
    this.securityViolation = error;
    this.failAll(error);
    void this.stop();
  }

  private failAll(error: Error) {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
    for (const pending of this.pendingTurns.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingTurns.clear();
    this.completedTurns.clear();
    this.completedItems.clear();
    this.imageGenerationStarts.clear();
    this.imageGenerationAttempts.clear();
    this.completedImageResults.clear();
    this.turnCallbacks.clear();
    this.turnDynamicToolNames.clear();
    this.dynamicToolCalls.clear();
    this.turnCallbackTasks.clear();
    this.turnCallbackErrors.clear();
    this.turnStartCallbacks = null;
    this.turnStartDynamicTools = null;
    this.sessionThreads.clear();
    this.turnErrors.clear();
    this.turnModeration.clear();
  }

  private async stopOnce() {
    const active = this.activeTurn;
    if (
      active !== null &&
      this.process !== null &&
      this.securityViolation === null
    ) {
      await this.request("turn/interrupt", active).catch(() => undefined);
    }
    this.activeTurn = null;
    const child = this.process;
    this.lines?.close();
    this.lines = null;
    this.process = null;
    if (child !== null && child.exitCode === null) {
      const exited = new Promise<void>((resolve) =>
        child.once("exit", () => resolve()),
      );
      child.kill("SIGTERM");
      await Promise.race([
        exited,
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    this.initialized = false;
    this.disabledMcpServerNames = [];
    this.turnStartInFlight = false;
    this.activeCapability = null;
    this.failAll(
      new CodexAppServerError("Codex App Server stopped", "stopped"),
    );
    const workspace = this.workspace;
    this.workspace = null;
    if (workspace !== null) await this.removeWorkspace(workspace);
  }

  async stop() {
    this.stoppingPromise ??= this.stopOnce().finally(() => {
      this.stoppingPromise = null;
    });
    await this.stoppingPromise;
  }

  installationStatus() {
    return this.installation;
  }
}
