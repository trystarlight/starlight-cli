import { verifyPortableMediaInspectorRuntime } from "./media-inspector.js";

import {
  AgentDriverApiClient,
  AgentDriverApiError,
} from "./driver-api-client.js";
import { AgentDriverService } from "./driver-service.js";
import {
  CodexAppServerClient,
  CodexAppServerError,
} from "./codex-app-server-client.js";
import { inspectCodexRuntime } from "./codex-runtime-discovery.js";
import {
  driverCommandEnvelope,
  type DriverCommandEnvelope,
  type DriverDiagnostic,
} from "./driver-command-output.js";
import { checkDriverUpdate } from "./driver-update-check.js";
import { STARLIGHT_CLI_VERSION } from "./version.js";

export interface DriverDoctorDependencies {
  readonly service?: AgentDriverService;
  readonly api?: AgentDriverApiClient;
  readonly codex?: CodexAppServerClient;
  readonly inspectCodex?: typeof inspectCodexRuntime;
  readonly checkUpdate?: typeof checkDriverUpdate;
}

function diagnostic(input: DriverDiagnostic): DriverDiagnostic {
  return input;
}

function authDiagnostic(error: unknown): DriverDiagnostic {
  if (error instanceof AgentDriverApiError) {
    if (error.code === "authentication-required") {
      return diagnostic({
        code: "STARLIGHT_PAIRING_MISSING",
        severity: "error",
        userImpact: "This device cannot read or claim Starlight turns.",
        safeAction: "Start browser pairing from the CLI.",
        humanRequired: true,
        surfaceToHuman: true,
        suggestedMessage:
          "Pair this device with Starlight before starting the resident driver.",
        evidence: { pairing: "missing" },
      });
    }
    if (error.code === "credential-expired") {
      return diagnostic({
        code: "STARLIGHT_PAIRING_EXPIRED",
        severity: "error",
        userImpact:
          "The stored Starlight pairing can no longer authorize driver work.",
        safeAction: "Pair the device again.",
        humanRequired: true,
        surfaceToHuman: true,
        suggestedMessage:
          "The Starlight pairing expired and needs browser approval again.",
        evidence: { pairing: "expired" },
      });
    }
    if (error.code === "driver-capability-unavailable") {
      return diagnostic({
        code: "TEXT_CAPABILITY_UNAVAILABLE",
        severity: "error",
        userImpact: "This older pairing cannot claim durable text turns.",
        safeAction: "Re-pair to obtain the current session and turn scopes.",
        humanRequired: true,
        surfaceToHuman: true,
        suggestedMessage:
          "Re-pair this device to enable the local text driver.",
        evidence: { textCapability: false },
      });
    }
    if (error.code === "resource-mismatch") {
      return diagnostic({
        code: "STARLIGHT_RESOURCE_MISMATCH",
        severity: "error",
        userImpact:
          "The pairing belongs to another Starlight resource or workspace.",
        safeAction:
          "Log out and pair against the intended Starlight environment.",
        humanRequired: true,
        surfaceToHuman: true,
        suggestedMessage:
          "This pairing is bound to another Starlight environment.",
        evidence: { resourceBinding: "mismatch" },
      });
    }
  }
  return diagnostic({
    code: "STARLIGHT_DRIVER_API_UNAVAILABLE",
    severity: "error",
    userImpact: "Driver authorization could not be verified.",
    safeAction: "Check the Starlight environment and run doctor again.",
    humanRequired: false,
    surfaceToHuman: true,
    suggestedMessage: "Starlight could not verify this driver connection.",
  });
}

export class DriverDoctor {
  private readonly service: AgentDriverService;
  private readonly api: AgentDriverApiClient;
  private readonly codex: CodexAppServerClient;
  private readonly inspectCodex: typeof inspectCodexRuntime;
  private readonly checkUpdate: typeof checkDriverUpdate;

  constructor(dependencies: DriverDoctorDependencies = {}) {
    this.service = dependencies.service ?? new AgentDriverService();
    this.api = dependencies.api ?? new AgentDriverApiClient();
    this.codex = dependencies.codex ?? new CodexAppServerClient();
    this.inspectCodex = dependencies.inspectCodex ?? inspectCodexRuntime;
    this.checkUpdate = dependencies.checkUpdate ?? checkDriverUpdate;
  }

  private async updateDiagnostic(): Promise<DriverDiagnostic> {
    const update = await this.checkUpdate().catch(() => ({
      installedVersion: STARLIGHT_CLI_VERSION,
      latestVersion: null,
      minimumVersion: null,
      updateAvailable: null,
      compatible: null,
      source: "unavailable" as const,
      checkedAt: null,
    }));
    return {
      code:
        update.source === "unavailable"
          ? "DRIVER_UPDATE_CHECK_UNAVAILABLE"
          : update.compatible === false
            ? "DRIVER_VERSION_INCOMPATIBLE"
            : update.updateAvailable === true
              ? "DRIVER_UPDATE_AVAILABLE"
              : "DRIVER_VERSION_CURRENT",
      severity:
        update.compatible === false
          ? "error"
          : update.updateAvailable === true || update.source === "unavailable"
            ? "warning"
            : "info",
      userImpact:
        update.source === "unavailable"
          ? "Installed, latest, and minimum compatibility could not be compared live."
          : update.compatible === false
            ? "This CLI is older than the minimum accepted driver version."
            : update.updateAvailable === true
              ? "A newer Starlight driver is available."
              : "The installed Starlight driver is current.",
      safeAction:
        update.compatible === false || update.updateAvailable === true
          ? "Update the Starlight CLI through the same trusted channel that installed it."
          : "No action is required.",
      humanRequired:
        update.compatible === false || update.updateAvailable === true,
      surfaceToHuman:
        update.source === "unavailable" ||
        update.compatible === false ||
        update.updateAvailable === true,
      suggestedMessage:
        update.source === "unavailable"
          ? "The bounded driver update check is temporarily unavailable."
          : update.compatible === false
            ? "This Starlight driver is below the minimum compatible version."
            : update.updateAvailable === true
              ? "A newer Starlight driver is available."
              : null,
      evidence: {
        installedVersion: update.installedVersion,
        latestVersion: update.latestVersion,
        minimumVersion: update.minimumVersion,
        source: update.source,
        checkedAt: update.checkedAt,
      },
    };
  }

  async inspectUpdate(
    command = "driver update",
  ): Promise<DriverCommandEnvelope> {
    const diagnostic = await this.updateDiagnostic();
    const state =
      diagnostic.severity === "error"
        ? "blocked"
        : diagnostic.severity === "warning"
          ? "attention"
          : "ok";
    return driverCommandEnvelope({
      command,
      state,
      summary:
        state === "ok"
          ? "The installed Starlight driver is current and compatible."
          : state === "attention"
            ? "The Starlight driver update state needs attention."
            : "The installed Starlight driver is below the compatible version floor.",
      diagnostics: [diagnostic],
      remediationRequiresHuman: diagnostic.humanRequired,
    });
  }

  async inspect(command = "doctor"): Promise<DriverCommandEnvelope> {
    const diagnostics: DriverDiagnostic[] = [];
    const [serviceResult, credentialResult] = await Promise.allSettled([
      this.service.status(),
      this.api.getCredentialContext(),
    ]);
    const credential =
      credentialResult.status === "fulfilled" ? credentialResult.value : null;
    if (serviceResult.status === "rejected") {
      diagnostics.push({
        code: "DRIVER_SERVICE_STATUS_UNAVAILABLE",
        severity: "error",
        userImpact: "The resident service state could not be inspected safely.",
        safeAction:
          "Run doctor again and inspect the Starlight driver log if this persists.",
        humanRequired: false,
        surfaceToHuman: true,
        suggestedMessage:
          "Starlight could not inspect the resident driver service.",
      });
    } else if (!serviceResult.value.supported) {
      diagnostics.push({
        code: "DRIVER_OS_UNSUPPORTED",
        severity: "error",
        userImpact:
          "Automatic resident driver installation is unavailable on this operating system.",
        safeAction: "Use foreground driver run or a supported macOS host.",
        humanRequired: false,
        surfaceToHuman: true,
        suggestedMessage:
          "Resident installation currently supports macOS only.",
        evidence: { supported: false },
      });
    } else if (!serviceResult.value.installed) {
      diagnostics.push({
        code: "DRIVER_NOT_INSTALLED",
        severity: "warning",
        userImpact:
          "The paired device will not wake itself to claim queued turns.",
        safeAction: "Install the resident Codex driver.",
        humanRequired: false,
        surfaceToHuman: true,
        suggestedMessage: "The resident text driver is not installed yet.",
        evidence: { installed: false },
      });
    } else if (
      !serviceResult.value.running &&
      serviceResult.value.lastExitStatus !== null &&
      serviceResult.value.lastExitStatus !== 0
    ) {
      diagnostics.push({
        code: "DRIVER_SERVICE_CRASHED",
        severity: "error",
        userImpact:
          "The resident process exited and cannot currently claim queued turns.",
        safeAction:
          "Run doctor, then inspect the bounded Starlight driver log.",
        humanRequired: false,
        surfaceToHuman: true,
        suggestedMessage: "The resident Starlight driver exited unexpectedly.",
        evidence: {
          installed: true,
          loaded: serviceResult.value.loaded,
          running: false,
          lastExitStatus: serviceResult.value.lastExitStatus,
        },
      });
    } else if (!serviceResult.value.running) {
      diagnostics.push({
        code:
          credential === null
            ? "DRIVER_SERVICE_OFFLINE"
            : "DRIVER_PAIRED_OFFLINE",
        severity: "warning",
        userImpact:
          credential === null
            ? "No resident process is available to claim queued turns."
            : "Pairing remains valid, but no resident process is available to claim turns.",
        safeAction: "Start the installed driver.",
        humanRequired: false,
        surfaceToHuman: true,
        suggestedMessage:
          credential === null
            ? "The resident Starlight driver is offline."
            : "This device is paired but its resident driver is offline.",
        evidence: {
          installed: true,
          loaded: serviceResult.value.loaded,
          running: false,
        },
      });
    } else {
      diagnostics.push({
        code: "DRIVER_SERVICE_RUNNING",
        severity: "info",
        userImpact:
          "The resident process is available to claim Starlight turns.",
        safeAction: "No action is required.",
        humanRequired: false,
        surfaceToHuman: false,
        suggestedMessage: null,
        evidence: {
          installed: true,
          loaded: true,
          running: true,
          pid: serviceResult.value.pid,
        },
      });
    }

    if (credential !== null) {
      diagnostics.push({
        code: "STARLIGHT_PAIRING_VALID",
        severity: "info",
        userImpact: "This device is paired with a Starlight workspace.",
        safeAction: "No action is required.",
        humanRequired: false,
        surfaceToHuman: false,
        suggestedMessage: null,
        evidence: {
          workspaceId: credential.workspace.workspaceId,
          workspaceName: credential.workspace.name,
          clientLabel: credential.clientLabel,
          resource: credential.resource,
          scopes: credential.scopes,
          expiresAt: credential.expiresAt,
          textCapability:
            credential.scopes.includes("session:read") &&
            credential.scopes.includes("turn:claim"),
        },
      });
    } else {
      diagnostics.push(
        authDiagnostic(
          credentialResult.status === "rejected"
            ? credentialResult.reason
            : new Error("Starlight pairing is unavailable"),
        ),
      );
    }

    let installation: Awaited<ReturnType<typeof inspectCodexRuntime>> = null;
    let installationError: unknown = null;
    try {
      installation = await this.inspectCodex();
    } catch (error) {
      installationError = error;
    }
    if (installationError !== null) {
      diagnostics.push({
        code: "CODEX_VERSION_UNREADABLE",
        severity: "error",
        userImpact:
          "Starlight cannot verify whether this Codex installation supports App Server.",
        safeAction: "Repair or update the Codex CLI, then run doctor again.",
        humanRequired: true,
        surfaceToHuman: true,
        suggestedMessage: "The installed Codex version could not be inspected.",
      });
    } else if (installation === null) {
      diagnostics.push({
        code: "CODEX_NOT_FOUND",
        severity: "error",
        userImpact: "The resident Starlight driver has no local text runtime.",
        safeAction:
          "Install or update the Codex CLI, then sign in with ChatGPT.",
        humanRequired: true,
        surfaceToHuman: true,
        suggestedMessage:
          "Codex is not installed or could not be found on PATH.",
        evidence: { installed: false },
      });
    } else if (!installation.compatible) {
      diagnostics.push({
        code: "CODEX_VERSION_INCOMPATIBLE",
        severity: "error",
        userImpact:
          "The installed Codex App Server lacks the protocol required by Starlight.",
        safeAction: "Update the Codex CLI.",
        humanRequired: true,
        surfaceToHuman: true,
        suggestedMessage: `Update Codex to ${installation.minimumVersion} or newer.`,
        evidence: {
          installedVersion: installation.installedVersion,
          minimumVersion: installation.minimumVersion,
        },
      });
    } else {
      try {
        const account = await this.codex.accountStatus();
        diagnostics.push({
          code: "CODEX_CHATGPT_AUTH_VALID",
          severity: "info",
          userImpact:
            "Codex can reason through text turns using the signed-in ChatGPT account.",
          safeAction: "No action is required.",
          humanRequired: false,
          surfaceToHuman: false,
          suggestedMessage: null,
          evidence: {
            installedVersion: installation.installedVersion,
            minimumVersion: installation.minimumVersion,
            authType: account.type,
            planType: account.planType,
          },
        });
        try {
          const image = await this.codex.imageCapabilityStatus();
          if (!image.available) {
            diagnostics.push({
              code:
                image.reason === "runtime-capability-unavailable"
                  ? "CODEX_IMAGE_CAPABILITY_UNAVAILABLE"
                  : "CODEX_IMAGEGEN_SKILL_UNAVAILABLE",
              severity: "warning",
              userImpact:
                "Text turns remain available, but this driver cannot claim image requests.",
              safeAction:
                image.reason === "runtime-capability-unavailable"
                  ? "Update Codex to a version that advertises image generation."
                  : "Repair or update the system imagegen skill, then run doctor again.",
              humanRequired: true,
              surfaceToHuman: true,
              suggestedMessage:
                "The local driver is text-ready but image generation is unavailable.",
              evidence: {
                text: true,
                image: false,
                reason: image.reason,
                installedVersion: image.codexRuntimeVersion,
              },
            });
          } else {
            await verifyPortableMediaInspectorRuntime();
            diagnostics.push({
              code: "CODEX_IMAGE_CAPABILITY_READY",
              severity: "info",
              userImpact:
                "The supported GPT Image 2 route and local media validator are ready.",
              safeAction: "No action is required.",
              humanRequired: false,
              surfaceToHuman: false,
              suggestedMessage: null,
              evidence: {
                text: true,
                image: true,
                model: "gpt-image-2",
                tool: "image_generation",
                installedVersion: image.codexRuntimeVersion,
              },
            });
          }
        } catch (error) {
          diagnostics.push({
            code: "CODEX_IMAGE_ADAPTER_UNAVAILABLE",
            severity: "warning",
            userImpact:
              "Text turns remain available, but image readiness could not be verified.",
            safeAction:
              "Run doctor again, then repair or update Codex if this persists.",
            humanRequired: false,
            surfaceToHuman: true,
            suggestedMessage:
              "The local driver is text-ready but image generation is unavailable.",
            evidence: {
              text: true,
              image: false,
              errorCode:
                error instanceof CodexAppServerError
                  ? error.code
                  : "media-validation",
            },
          });
        }
      } catch (error) {
        const authFailure =
          error instanceof CodexAppServerError &&
          (error.code === "chatgpt-auth-required" ||
            error.code === "chatgpt-auth-unsupported");
        diagnostics.push(
          authFailure
            ? {
                code: "CODEX_CHATGPT_AUTH_MISSING",
                severity: "error",
                userImpact: "Codex cannot reason through Starlight turns.",
                safeAction:
                  "Sign in through the Codex CLI or desktop app using ChatGPT.",
                humanRequired: true,
                surfaceToHuman: true,
                suggestedMessage:
                  "Codex needs an active ChatGPT sign-in; API-key auth is not accepted.",
                evidence: {
                  installedVersion: installation.installedVersion,
                  minimumVersion: installation.minimumVersion,
                  authType: "unavailable",
                },
              }
            : {
                code: "CODEX_APP_SERVER_UNAVAILABLE",
                severity: "error",
                userImpact:
                  "The local text runtime could not complete its startup protocol.",
                safeAction:
                  "Run doctor again, then inspect the Starlight driver log.",
                humanRequired: false,
                surfaceToHuman: true,
                suggestedMessage:
                  "Codex App Server is installed but unavailable.",
                evidence: {
                  installedVersion: installation.installedVersion,
                  minimumVersion: installation.minimumVersion,
                  errorCode:
                    error instanceof CodexAppServerError
                      ? error.code
                      : "unknown",
                },
              },
        );
      } finally {
        await this.codex.stop();
      }
    }

    diagnostics.push(await this.updateDiagnostic());
    const error = diagnostics.some((item) => item.severity === "error");
    const warning = diagnostics.some((item) => item.severity === "warning");
    const state = error ? "blocked" : warning ? "attention" : "ok";
    const remediation =
      diagnostics.find((item) => item.code === "STARLIGHT_PAIRING_MISSING") !==
      undefined
        ? "starlight auth login"
        : diagnostics.find(
              (item) => item.code === "CODEX_CHATGPT_AUTH_MISSING",
            ) !== undefined
          ? "codex login"
          : diagnostics.find((item) => item.code === "DRIVER_NOT_INSTALLED") !==
              undefined
            ? "starlight driver install --runtime codex"
            : diagnostics.find(
                  (item) =>
                    item.code === "DRIVER_PAIRED_OFFLINE" ||
                    item.code === "DRIVER_SERVICE_OFFLINE",
                ) !== undefined
              ? "starlight driver start"
              : null;
    return driverCommandEnvelope({
      command,
      state,
      summary:
        state === "ok"
          ? "The resident Starlight Codex driver is ready."
          : state === "attention"
            ? "The Starlight Codex driver is usable with attention needed."
            : "The Starlight Codex driver is blocked.",
      diagnostics,
      remediationCommand: remediation,
      remediationRequiresHuman: diagnostics.some(
        (item) => item.severity === "error" && item.humanRequired,
      ),
    });
  }
}
