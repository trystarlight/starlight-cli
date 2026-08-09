import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  link,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { discoverCodexExecutable } from "./codex-runtime-discovery.js";

const execFileAsync = promisify(execFile);
const DRIVER_LABEL = "io.trystarlight.cli.codex-driver";

export interface AgentDriverServiceStatus {
  readonly supported: boolean;
  readonly installed: boolean;
  readonly loaded: boolean;
  readonly running: boolean;
  readonly pid: number | null;
  readonly lastExitStatus: number | null;
  readonly label: string;
  readonly plistPath: string;
}

export interface AgentDriverServiceDependencies {
  readonly platform?: NodeJS.Platform;
  readonly uid?: number;
  readonly homeDirectory?: string;
  readonly nodeExecutable?: string;
  readonly cliEntry?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly execFile?: typeof execFileAsync;
  readonly discoverCodex?: typeof discoverCodexExecutable;
  readonly sleep?: (durationMs: number) => Promise<void>;
}

function xml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function plist(input: {
  readonly nodeExecutable: string;
  readonly cliEntry: string;
  readonly logPath: string;
  readonly environment: Readonly<Record<string, string>>;
}) {
  const environment = Object.entries(input.environment)
    .map(
      ([key, value]) =>
        `      <key>${xml(key)}</key>\n      <string>${xml(value)}</string>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${DRIVER_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xml(input.nodeExecutable)}</string>
      <string>${xml(input.cliEntry)}</string>
      <string>driver</string>
      <string>run</string>
      <string>--json</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${environment}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ProcessType</key>
    <string>Background</string>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>StandardOutPath</key>
    <string>${xml(input.logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(input.logPath)}</string>
  </dict>
</plist>
`;
}

function missingFile(error: unknown) {
  return isErrorCode(error, "ENOENT");
}

function isErrorCode(error: unknown, code: string) {
  return isRecord(error) && error["code"] === code;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class AgentDriverService {
  private readonly platform: NodeJS.Platform;
  private readonly uid: number;
  private readonly homeDirectory: string;
  private readonly nodeExecutable: string;
  private readonly cliEntry: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly execute: typeof execFileAsync;
  private readonly discoverCodex: typeof discoverCodexExecutable;
  private readonly sleep: (durationMs: number) => Promise<void>;

  constructor(dependencies: AgentDriverServiceDependencies = {}) {
    this.platform = dependencies.platform ?? process.platform;
    this.uid = dependencies.uid ?? process.getuid?.() ?? -1;
    this.homeDirectory = dependencies.homeDirectory ?? homedir();
    this.nodeExecutable = dependencies.nodeExecutable ?? process.execPath;
    this.cliEntry =
      dependencies.cliEntry ??
      resolve(dirname(fileURLToPath(import.meta.url)), "main.js");
    this.environment = dependencies.environment ?? process.env;
    this.execute = dependencies.execFile ?? execFileAsync;
    this.discoverCodex = dependencies.discoverCodex ?? discoverCodexExecutable;
    this.sleep =
      dependencies.sleep ??
      (async (durationMs) => {
        await new Promise<void>((resolve) => setTimeout(resolve, durationMs));
      });
  }

  get plistPath() {
    return resolve(
      this.homeDirectory,
      "Library",
      "LaunchAgents",
      `${DRIVER_LABEL}.plist`,
    );
  }

  get logPath() {
    return resolve(
      this.homeDirectory,
      "Library",
      "Logs",
      "Starlight",
      "codex-driver.log",
    );
  }

  private domain() {
    if (this.uid < 0)
      throw new Error("The current macOS user ID is unavailable");
    return `gui/${String(this.uid)}`;
  }

  private serviceTarget() {
    return `${this.domain()}/${DRIVER_LABEL}`;
  }

  async status(): Promise<AgentDriverServiceStatus> {
    const supported = this.platform === "darwin";
    let installed = false;
    try {
      await access(this.plistPath);
      installed = true;
    } catch (error) {
      if (!missingFile(error)) throw error;
    }
    if (!supported || !installed) {
      return {
        supported,
        installed,
        loaded: false,
        running: false,
        pid: null,
        lastExitStatus: null,
        label: DRIVER_LABEL,
        plistPath: this.plistPath,
      };
    }
    try {
      const { stdout } = await this.execute(
        "launchctl",
        ["print", this.serviceTarget()],
        {
          timeout: 5_000,
        },
      );
      const state = /^\s*state = (\S+)\s*$/mu.exec(stdout)?.[1] ?? null;
      const pidText = /^\s*pid = (\d+)\s*$/mu.exec(stdout)?.[1] ?? null;
      const lastExitText =
        /^\s*last exit code = (-?\d+)\s*$/mu.exec(stdout)?.[1] ?? null;
      return {
        supported: true,
        installed: true,
        loaded: true,
        running: state === "running",
        pid: pidText === null ? null : Number(pidText),
        lastExitStatus: lastExitText === null ? null : Number(lastExitText),
        label: DRIVER_LABEL,
        plistPath: this.plistPath,
      };
    } catch {
      return {
        supported: true,
        installed: true,
        loaded: false,
        running: false,
        pid: null,
        lastExitStatus: null,
        label: DRIVER_LABEL,
        plistPath: this.plistPath,
      };
    }
  }

  async install() {
    if (this.platform !== "darwin") {
      throw new Error(
        "Resident driver installation is currently supported on macOS only",
      );
    }
    await Promise.all([
      mkdir(dirname(this.plistPath), { recursive: true, mode: 0o700 }),
      mkdir(dirname(this.logPath), { recursive: true, mode: 0o700 }),
      access(this.cliEntry),
    ]);
    const path =
      this.environment["PATH"] ??
      "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
    const codexExecutable = await this.discoverCodex(this.environment);
    if (codexExecutable === null) {
      throw new Error("Codex is not installed or is not on PATH");
    }
    const driverEnvironment: Record<string, string> = {
      PATH: path,
      HOME: this.homeDirectory,
      STARLIGHT_CODEX_PATH: codexExecutable,
      STARLIGHT_RESIDENT_DRIVER: "1",
    };
    const codexHome = this.environment["CODEX_HOME"];
    if (codexHome !== undefined) driverEnvironment["CODEX_HOME"] = codexHome;
    for (const key of ["TMPDIR", "LANG", "LC_ALL"]) {
      const value = this.environment[key];
      if (value !== undefined) driverEnvironment[key] = value;
    }
    const contents = plist({
      nodeExecutable: this.nodeExecutable,
      cliEntry: this.cliEntry,
      logPath: this.logPath,
      environment: driverEnvironment,
    });
    const existingContents = await readFile(this.plistPath, "utf8").catch(
      () => null,
    );
    if (existingContents === contents) return await this.start();
    const temporary = `${this.plistPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, contents, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      const current = await this.status();
      if (current.loaded) {
        await this.execute("launchctl", ["bootout", this.serviceTarget()], {
          timeout: 10_000,
        });
      }
      await rename(temporary, this.plistPath);
    } finally {
      await rm(temporary, { force: true });
    }
    return await this.start();
  }

  async start() {
    if (this.platform !== "darwin") {
      throw new Error(
        "Resident driver services are currently supported on macOS only",
      );
    }
    const current = await this.status();
    if (!current.installed) {
      throw new Error(
        "The resident driver is not installed; run starlight driver install",
      );
    }
    if (!current.loaded) {
      await this.execute(
        "launchctl",
        ["bootstrap", this.domain(), this.plistPath],
        {
          timeout: 10_000,
        },
      );
    } else if (!current.running) {
      await this.execute(
        "launchctl",
        ["kickstart", "-k", this.serviceTarget()],
        {
          timeout: 10_000,
        },
      );
    }
    if (current.running) return current;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const status = await this.status();
      if (
        status.running ||
        (status.lastExitStatus !== null && status.lastExitStatus !== 0)
      ) {
        return status;
      }
      await this.sleep(150);
    }
    return await this.status();
  }

  async stop() {
    if (this.platform !== "darwin") {
      throw new Error(
        "Resident driver services are currently supported on macOS only",
      );
    }
    const current = await this.status();
    if (current.loaded) {
      await this.execute("launchctl", ["bootout", this.serviceTarget()], {
        timeout: 10_000,
      });
    }
    return await this.status();
  }

  async uninstall() {
    if (this.platform !== "darwin") {
      throw new Error(
        "Resident driver services are currently supported on macOS only",
      );
    }
    const stopped = await this.stop();
    if (stopped.running)
      throw new Error("The resident driver did not stop cleanly");
    await rm(this.plistPath, { force: true });
    return await this.status();
  }
}

export interface AgentDriverProcessLockDependencies {
  readonly root?: string;
  readonly pid?: number;
  readonly processExists?: (pid: number) => boolean;
  readonly now?: () => number;
}

export class AgentDriverProcessLock {
  private readonly root: string;
  private readonly pid: number;
  private readonly processExists: (pid: number) => boolean;
  private readonly now: () => number;
  private acquired = false;

  constructor(dependencies: AgentDriverProcessLockDependencies = {}) {
    this.root =
      dependencies.root ??
      resolve(
        homedir(),
        "Library",
        "Application Support",
        "Starlight",
        "codex-driver.lock",
      );
    this.pid = dependencies.pid ?? process.pid;
    this.processExists =
      dependencies.processExists ??
      ((pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      });
    this.now = dependencies.now ?? Date.now;
  }

  async acquire() {
    await mkdir(dirname(this.root), { recursive: true, mode: 0o700 });
    const prepared = `${this.root}.${String(this.pid)}.${randomUUID()}.pending`;
    await writeFile(prepared, `${String(this.pid)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await link(prepared, this.root);
          this.acquired = true;
          return;
        } catch (error) {
          if (!isErrorCode(error, "EEXIST")) throw error;
          const existingPid = await this.readOwnerPid();
          if (
            Number.isSafeInteger(existingPid) &&
            existingPid > 0 &&
            this.processExists(existingPid)
          ) {
            throw new Error(
              `A Starlight resident driver is already running with PID ${String(existingPid)}`,
              { cause: error },
            );
          }
          if (!Number.isSafeInteger(existingPid) || existingPid <= 0) {
            const details = await stat(this.root);
            if (this.now() - details.mtimeMs < 5_000) {
              throw new Error(
                "A Starlight resident driver is already starting",
                {
                  cause: error,
                },
              );
            }
          }
          await rm(this.root, { recursive: true, force: true });
        }
      }
      throw new Error(
        "The Starlight resident driver lock could not be acquired",
      );
    } finally {
      await rm(prepared, { force: true });
    }
  }

  private async readOwnerPid() {
    const raw = await readFile(this.root, "utf8").catch(async () => {
      return await readFile(resolve(this.root, "pid"), "utf8").catch(() => "");
    });
    const value = raw.trim();
    return value.length === 0 ? Number.NaN : Number(value);
  }

  async release() {
    if (!this.acquired) return;
    this.acquired = false;
    if ((await this.readOwnerPid()) !== this.pid) return;
    await rm(this.root, { recursive: true, force: true });
  }
}
