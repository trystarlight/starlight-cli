export type DriverCommandState = "ok" | "attention" | "blocked" | "failed";
type DriverDiagnosticSeverity = "info" | "warning" | "error";

export interface DriverDiagnostic {
  readonly code: string;
  readonly severity: DriverDiagnosticSeverity;
  readonly userImpact: string;
  readonly safeAction: string;
  readonly humanRequired: boolean;
  readonly surfaceToHuman: boolean;
  readonly suggestedMessage: string | null;
  readonly evidence?: Readonly<Record<string, unknown>>;
}

export interface DriverCommandEnvelope {
  readonly schemaVersion: "starlight.driver-command.v1";
  readonly command: string;
  readonly state: DriverCommandState;
  readonly summary: string;
  readonly diagnostics: readonly DriverDiagnostic[];
  readonly remediation: {
    readonly command: string | null;
    readonly humanRequired: boolean;
  };
}

export function driverCommandEnvelope(input: {
  readonly command: string;
  readonly state: DriverCommandState;
  readonly summary: string;
  readonly diagnostics?: readonly DriverDiagnostic[];
  readonly remediationCommand?: string | null;
  readonly remediationRequiresHuman?: boolean;
}): DriverCommandEnvelope {
  return {
    schemaVersion: "starlight.driver-command.v1",
    command: input.command,
    state: input.state,
    summary: input.summary,
    diagnostics: input.diagnostics ?? [],
    remediation: {
      command: input.remediationCommand ?? null,
      humanRequired: input.remediationRequiresHuman ?? false,
    },
  };
}

export function renderDriverCommand(envelope: DriverCommandEnvelope) {
  const lines = [envelope.summary];
  for (const diagnostic of envelope.diagnostics.filter(
    (item) => item.surfaceToHuman,
  )) {
    lines.push(`- ${diagnostic.suggestedMessage ?? diagnostic.userImpact}`);
  }
  if (envelope.remediation.command !== null) {
    lines.push(`Next: ${envelope.remediation.command}`);
  }
  return `${lines.join("\n")}\n`;
}

function safeErrorMessage(error: unknown) {
  if (!(error instanceof Error)) return "The driver operation failed.";
  return error.message
    .replaceAll(
      /(?:sk|stl_agent|stl_connect)_[A-Za-z0-9_-]{8,}/gu,
      "[credential]",
    )
    .slice(0, 300);
}

export function driverCommandFailure(
  command: string,
  error: unknown,
): DriverCommandEnvelope {
  const message = safeErrorMessage(error);
  const codexNotFound = /Codex is not installed/u.test(message);
  const unsupported = /supported on macOS only/u.test(message);
  const notInstalled = !codexNotFound && /not installed/u.test(message);
  const alreadyRunning = /already running/u.test(message);
  const code = codexNotFound
    ? "CODEX_NOT_FOUND"
    : unsupported
      ? "DRIVER_OS_UNSUPPORTED"
      : notInstalled
        ? "DRIVER_NOT_INSTALLED"
        : alreadyRunning
          ? "DRIVER_ALREADY_RUNNING"
          : "DRIVER_SERVICE_OPERATION_FAILED";
  const remediationCommand = codexNotFound
    ? "starlight doctor --json"
    : notInstalled
      ? "starlight driver install --runtime codex"
      : alreadyRunning
        ? "starlight driver status --json"
        : null;
  return driverCommandEnvelope({
    command,
    state: unsupported || notInstalled || alreadyRunning ? "blocked" : "failed",
    summary: "The resident Starlight driver operation did not complete.",
    diagnostics: [
      {
        code,
        severity: "error",
        userImpact: message,
        safeAction:
          remediationCommand === null
            ? "Run starlight doctor --json before trying again."
            : `Run ${remediationCommand}.`,
        humanRequired: false,
        surfaceToHuman: true,
        suggestedMessage: message,
        evidence: { failure: code },
      },
    ],
    remediationCommand,
  });
}
