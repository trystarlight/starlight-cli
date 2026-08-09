import { Command, Option } from "commander";

import { AgentBridgeClient } from "./auth-client.js";
import {
  AgentDriverRuntime,
  type AgentDriverRuntimeEvent,
} from "./driver-runtime.js";
import {
  AgentDriverProcessLock,
  AgentDriverService,
} from "./driver-service.js";
import { DriverDoctor } from "./driver-doctor.js";
import {
  driverCommandEnvelope,
  driverCommandFailure,
  renderDriverCommand,
  type DriverCommandEnvelope,
} from "./driver-command-output.js";
import {
  STARLIGHT_CLI_VERSION,
  STARLIGHT_DRIVER_COMPATIBILITY,
  STARLIGHT_DRIVER_PROTOCOL_VERSION,
  STARLIGHT_PRODUCTION_ORIGIN,
} from "./version.js";

export const CLI_EXIT = Object.freeze({
  ok: 0,
  failed: 1,
  attention: 2,
  usage: 64,
  unsupported: 69,
});

interface ProgramDependencies {
  readonly auth: AgentBridgeClient;
  readonly service: AgentDriverService;
  readonly doctor: DriverDoctor;
  readonly createRuntime: (
    onEvent: (event: AgentDriverRuntimeEvent) => void,
  ) => AgentDriverRuntime;
  readonly createLock: () => AgentDriverProcessLock;
  readonly writeOut: (value: string) => void;
  readonly writeErr: (value: string) => void;
  readonly setExitCode: (code: number) => void;
}

function defaults(): ProgramDependencies {
  return {
    auth: new AgentBridgeClient(),
    service: new AgentDriverService(),
    doctor: new DriverDoctor(),
    createRuntime: (onEvent) => new AgentDriverRuntime({ onEvent }),
    createLock: () => new AgentDriverProcessLock(),
    writeOut: (value) => process.stdout.write(value),
    writeErr: (value) => process.stderr.write(value),
    setExitCode: (code) => {
      process.exitCode = code;
    },
  };
}

function json(value: unknown) {
  return `${JSON.stringify(value)}\n`;
}

function resultExitCode(result: DriverCommandEnvelope) {
  return result.state === "ok"
    ? CLI_EXIT.ok
    : result.state === "failed"
      ? CLI_EXIT.failed
      : CLI_EXIT.attention;
}

export function createProgram(overrides: Partial<ProgramDependencies> = {}) {
  const dependencies = { ...defaults(), ...overrides };
  const program = new Command()
    .name("starlight")
    .description("Connect a user-owned Codex installation to Starlight.")
    .version(STARLIGHT_CLI_VERSION)
    .showHelpAfterError()
    .exitOverride();

  const writeEnvelope = (
    value: DriverCommandEnvelope,
    machine: boolean,
    strict = false,
  ) => {
    dependencies.writeOut(machine ? json(value) : renderDriverCommand(value));
    if (strict || value.state === "failed")
      dependencies.setExitCode(resultExitCode(value));
  };
  const fail = (command: string, error: unknown, machine: boolean) => {
    const value = driverCommandFailure(command, error);
    if (machine) dependencies.writeOut(json(value));
    else dependencies.writeErr(renderDriverCommand(value));
    dependencies.setExitCode(
      value.diagnostics.some((item) => item.code === "DRIVER_OS_UNSUPPORTED")
        ? CLI_EXIT.unsupported
        : CLI_EXIT.failed,
    );
  };

  const auth = program
    .command("auth")
    .description("Manage browser-approved workspace pairing.");
  auth
    .command("login")
    .option(
      "--api-url <url>",
      "Starlight agent API base URL",
      STARLIGHT_PRODUCTION_ORIGIN,
    )
    .option(
      "--web-url <url>",
      "Starlight browser base URL",
      STARLIGHT_PRODUCTION_ORIGIN,
    )
    .option("--label <text>", "Device label", "Codex on this Mac")
    .action(
      async (options: { apiUrl: string; webUrl: string; label: string }) => {
        dependencies.writeOut(
          json(
            await dependencies.auth.startLogin({
              ...options,
              clientLabel: options.label,
            }),
          ),
        );
      },
    );
  auth
    .command("complete")
    .action(async () =>
      dependencies.writeOut(json(await dependencies.auth.completeLogin())),
    );
  auth
    .command("status")
    .action(async () =>
      dependencies.writeOut(json(await dependencies.auth.status())),
    );
  auth
    .command("logout")
    .action(async () =>
      dependencies.writeOut(json(await dependencies.auth.logout())),
    );

  const driver = program
    .command("driver")
    .description("Manage the local Codex driver.");
  driver
    .command("install")
    .addOption(
      new Option("--runtime <runtime>").choices(["codex"]).default("codex"),
    )
    .option("--json", "Print stable JSON", false)
    .action(async (options: { json: boolean }) => {
      try {
        const status = await dependencies.service.install();
        writeEnvelope(
          driverCommandEnvelope({
            command: "driver install",
            state: status.running ? "ok" : "attention",
            summary: status.running
              ? "The resident Starlight driver is installed and running."
              : "The resident Starlight driver was installed but is not yet running.",
            remediationCommand: status.running
              ? null
              : "starlight doctor --json",
          }),
          options.json,
          true,
        );
      } catch (error) {
        fail("driver install", error, options.json);
      }
    });
  for (const commandName of ["start", "stop"] as const) {
    driver
      .command(commandName)
      .option("--json", "Print stable JSON", false)
      .action(async (options: { json: boolean }) => {
        try {
          const status = await dependencies.service[commandName]();
          const ready =
            commandName === "start" ? status.running : !status.running;
          writeEnvelope(
            driverCommandEnvelope({
              command: `driver ${commandName}`,
              state: ready ? "ok" : "failed",
              summary: ready
                ? commandName === "start"
                  ? "The resident Starlight driver is running."
                  : "The resident Starlight driver is stopped; pairing was preserved."
                : `The resident Starlight driver did not ${commandName} cleanly.`,
            }),
            options.json,
            true,
          );
        } catch (error) {
          fail(`driver ${commandName}`, error, options.json);
        }
      });
  }
  driver
    .command("status")
    .option("--json", "Print stable JSON", false)
    .action(async (options: { json: boolean }) =>
      writeEnvelope(
        await dependencies.doctor.inspect("driver status"),
        options.json,
      ),
    );
  driver
    .command("update")
    .option("--json", "Print stable JSON", false)
    .action(async (options: { json: boolean }) =>
      writeEnvelope(
        await dependencies.doctor.inspectUpdate("driver update"),
        options.json,
      ),
    );
  driver
    .command("run")
    .option("--json", "Print JSON lifecycle events", false)
    .action(async (options: { json: boolean }) => {
      const lock = dependencies.createLock();
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try {
        await lock.acquire();
        await dependencies
          .createRuntime((event) => {
            if (event.type !== "idle")
              dependencies.writeOut(
                options.json ? json(event) : `${event.message}\n`,
              );
          })
          .run(controller.signal);
      } catch (error) {
        fail("driver run", error, options.json);
      } finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        await lock.release();
      }
    });

  program
    .command("doctor")
    .option("--json", "Print stable JSON", false)
    .option("--strict", "Return a nonzero code for any non-ready state", false)
    .action(async (options: { json: boolean; strict: boolean }) =>
      writeEnvelope(
        await dependencies.doctor.inspect(),
        options.json,
        options.strict,
      ),
    );
  program
    .command("version")
    .option("--json", "Print stable JSON", false)
    .action((options: { json: boolean }) => {
      const value = {
        schemaVersion: "starlight.cli-version.v1",
        cliVersion: STARLIGHT_CLI_VERSION,
        driverProtocolVersion: STARLIGHT_DRIVER_PROTOCOL_VERSION,
        compatibility: STARLIGHT_DRIVER_COMPATIBILITY,
        platform: "macos",
      };
      dependencies.writeOut(
        options.json ? json(value) : `starlight ${STARLIGHT_CLI_VERSION}\n`,
      );
    });
  program
    .command("update")
    .option("--json", "Print stable JSON", false)
    .action(async (options: { json: boolean }) =>
      writeEnvelope(
        await dependencies.doctor.inspectUpdate("update"),
        options.json,
        true,
      ),
    );
  program
    .command("uninstall")
    .option("--revoke", "Also revoke the paired workspace credential", false)
    .option("--json", "Print stable JSON", false)
    .action(async (options: { revoke: boolean; json: boolean }) => {
      try {
        await dependencies.service.uninstall();
        if (options.revoke) await dependencies.auth.logout();
        writeEnvelope(
          driverCommandEnvelope({
            command: "uninstall",
            state: "ok",
            summary: options.revoke
              ? "The resident driver was removed and pairing was revoked."
              : "The resident driver was removed; pairing was preserved.",
          }),
          options.json,
        );
      } catch (error) {
        fail("uninstall", error, options.json);
      }
    });

  return program;
}
