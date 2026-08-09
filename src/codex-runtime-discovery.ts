import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MINIMUM_CODEX_APP_SERVER_VERSION = "0.144.0";

export interface CodexRuntimeInstallation {
  readonly executable: string;
  readonly installedVersion: string;
  readonly minimumVersion: string;
  readonly compatible: boolean;
}

function parseVersion(value: string) {
  const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:[-+\s]|$)/u.exec(value);
  if (match === null) throw new Error("Codex returned an unrecognized version");
  return [Number(match[1]), Number(match[2]), Number(match[3])] as const;
}

export function compareVersions(left: string, right: string) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < a.length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function executableCandidate(value: string) {
  try {
    await access(value, constants.X_OK);
    return value;
  } catch {
    return null;
  }
}

export async function discoverCodexExecutable(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const explicit = environment["STARLIGHT_CODEX_PATH"]?.trim();
  if (explicit) {
    if (!isAbsolute(explicit)) {
      throw new Error(
        "STARLIGHT_CODEX_PATH must be an absolute executable path",
      );
    }
    return await executableCandidate(explicit);
  }
  for (const directory of (environment["PATH"] ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = await executableCandidate(join(directory, "codex"));
    if (candidate !== null) return candidate;
  }
  return null;
}

export async function inspectCodexRuntime(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<CodexRuntimeInstallation | null> {
  const executable = await discoverCodexExecutable(environment);
  if (executable === null) return null;
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(executable, ["--version"], {
      timeout: 5_000,
      env: {
        PATH: environment["PATH"] ?? "",
        ...(environment["HOME"] === undefined
          ? {}
          : { HOME: environment["HOME"] }),
        ...(environment["CODEX_HOME"] === undefined
          ? {}
          : { CODEX_HOME: environment["CODEX_HOME"] }),
      },
    }));
  } catch (error) {
    throw new Error("Codex is installed but its version could not be read", {
      cause: error,
    });
  }
  const installedVersion = parseVersion(stdout).join(".");
  return {
    executable,
    installedVersion,
    minimumVersion: MINIMUM_CODEX_APP_SERVER_VERSION,
    compatible:
      compareVersions(installedVersion, MINIMUM_CODEX_APP_SERVER_VERSION) >= 0,
  };
}
