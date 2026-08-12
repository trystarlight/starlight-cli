import { CommanderError } from "commander";
import { describe, expect, it, vi } from "vitest";

import { AgentBridgeClient } from "./auth-client.js";
import { AgentDriverService } from "./driver-service.js";
import { createProgram } from "./program.js";

const localRecovery = {
  schemaVersion: "starlight.agent-auth.v1" as const,
  status: "succeeded" as const,
  connected: false,
  remoteRevocation: "skipped" as const,
  localCredentialsCleared: true,
  note: "Local Starlight agent credentials and pending pairing state were cleared.",
  warning:
    "Remote revocation was skipped. A still-valid remote credential may remain active until revoked or expired.",
};

function authProgram(input?: {
  readonly logout?: ReturnType<typeof vi.fn>;
  readonly clearLocalCredentials?: ReturnType<typeof vi.fn>;
  readonly uninstall?: ReturnType<typeof vi.fn>;
}) {
  const logout =
    input?.logout ??
    vi.fn(async () => ({
      schemaVersion: "starlight.agent-auth.v1" as const,
      status: "succeeded" as const,
      connected: false,
      note: "Remote credential revoked and local agent credentials cleared.",
    }));
  const clearLocalCredentials =
    input?.clearLocalCredentials ?? vi.fn(async () => localRecovery);
  const uninstall = input?.uninstall ?? vi.fn(async () => undefined);
  const output: string[] = [];
  const errors: string[] = [];
  const exitCodes: number[] = [];
  const program = createProgram({
    auth: { logout, clearLocalCredentials } as unknown as AgentBridgeClient,
    service: { uninstall } as unknown as AgentDriverService,
    writeOut: (value) => output.push(value),
    writeErr: (value) => errors.push(value),
    setExitCode: (value) => exitCodes.push(value),
  });
  const configureOutput = (command: typeof program) => {
    command.configureOutput({
      writeOut: (value) => output.push(value),
      writeErr: (value) => errors.push(value),
    });
    for (const child of command.commands) configureOutput(child);
  };
  configureOutput(program);
  return {
    program,
    logout,
    clearLocalCredentials,
    uninstall,
    output,
    errors,
    exitCodes,
  };
}

describe("auth logout command", () => {
  it("keeps ordinary logout on the remote-revocation path", async () => {
    const fixture = authProgram();

    await fixture.program.parseAsync(["node", "starlight", "auth", "logout"]);

    expect(fixture.logout).toHaveBeenCalledOnce();
    expect(fixture.clearLocalCredentials).not.toHaveBeenCalled();
    expect(JSON.parse(fixture.output.join(""))).toMatchObject({
      status: "succeeded",
      connected: false,
      note: "Remote credential revoked and local agent credentials cleared.",
    });
  });

  it("requires the exact local-only flag and emits stable recovery JSON", async () => {
    const fixture = authProgram();

    await fixture.program.parseAsync([
      "node",
      "starlight",
      "auth",
      "logout",
      "--local-only",
      "--json",
    ]);

    expect(fixture.logout).not.toHaveBeenCalled();
    expect(fixture.clearLocalCredentials).toHaveBeenCalledOnce();
    expect(JSON.parse(fixture.output.join(""))).toEqual(localRecovery);
  });

  it("prints conspicuous human recovery results and warnings", async () => {
    const fixture = authProgram();

    await fixture.program.parseAsync([
      "node",
      "starlight",
      "auth",
      "logout",
      "--local-only",
    ]);

    expect(fixture.output.join("")).toBe(
      `${localRecovery.note}\n${localRecovery.warning}\n`,
    );
  });

  it("does not accept an abbreviated recovery option", async () => {
    const fixture = authProgram();

    await expect(
      fixture.program.parseAsync([
        "node",
        "starlight",
        "auth",
        "logout",
        "--local",
      ]),
    ).rejects.toBeInstanceOf(CommanderError);
    expect(fixture.logout).not.toHaveBeenCalled();
    expect(fixture.clearLocalCredentials).not.toHaveBeenCalled();
  });

  it("emits stable failure JSON without claiming local clearing", async () => {
    const clearLocalCredentials = vi.fn(async () => {
      throw new Error(
        "Starlight could not clear local agent credentials; local recovery did not complete",
      );
    });
    const fixture = authProgram({ clearLocalCredentials });

    await fixture.program.parseAsync([
      "node",
      "starlight",
      "auth",
      "logout",
      "--local-only",
      "--json",
    ]);

    expect(JSON.parse(fixture.output.join(""))).toEqual({
      schemaVersion: "starlight.agent-auth.v1",
      status: "failed",
      remoteRevocation: "skipped",
      localCredentialsCleared: false,
      error: {
        code: "LOCAL_CREDENTIAL_CLEAR_FAILED",
        message:
          "Starlight could not clear local agent credentials; local recovery did not complete.",
      },
    });
    expect(fixture.exitCodes).toEqual([1]);
  });

  it("surfaces human clearing failure without printing false success", async () => {
    const clearLocalCredentials = vi.fn(async () => {
      throw new Error(
        "Starlight could not clear local agent credentials; local recovery did not complete",
      );
    });
    const fixture = authProgram({ clearLocalCredentials });

    await expect(
      fixture.program.parseAsync([
        "node",
        "starlight",
        "auth",
        "logout",
        "--local-only",
      ]),
    ).rejects.toThrow("local recovery did not complete");
    expect(fixture.output).toEqual([]);
  });

  it("documents that local-only recovery skips remote revocation", () => {
    const fixture = authProgram();
    const auth = fixture.program.commands.find(
      (command) => command.name() === "auth",
    );
    const logout = auth?.commands.find(
      (command) => command.name() === "logout",
    );

    expect(logout?.helpInformation()).toContain("--local-only");
    expect(logout?.helpInformation()).toContain("RECOVERY ONLY");
    expect(logout?.helpInformation()).toContain("skip remote revocation");
    expect(logout?.helpInformation()).toContain("local Keychain pairing state");
  });

  it("keeps default uninstall pairing-preserving", async () => {
    const fixture = authProgram();

    await fixture.program.parseAsync([
      "node",
      "starlight",
      "uninstall",
      "--json",
    ]);

    expect(fixture.uninstall).toHaveBeenCalledOnce();
    expect(fixture.logout).not.toHaveBeenCalled();
    expect(fixture.clearLocalCredentials).not.toHaveBeenCalled();
    expect(JSON.parse(fixture.output.join(""))).toMatchObject({
      command: "uninstall",
      state: "ok",
      summary: "The resident driver was removed; pairing was preserved.",
    });
  });

  it("keeps uninstall revoke on ordinary remote logout semantics", async () => {
    const fixture = authProgram();

    await fixture.program.parseAsync([
      "node",
      "starlight",
      "uninstall",
      "--revoke",
      "--json",
    ]);

    expect(fixture.uninstall).toHaveBeenCalledOnce();
    expect(fixture.logout).toHaveBeenCalledOnce();
    expect(fixture.clearLocalCredentials).not.toHaveBeenCalled();
    expect(fixture.uninstall.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.logout.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(JSON.parse(fixture.output.join(""))).toMatchObject({
      command: "uninstall",
      state: "ok",
      summary: "The resident driver was removed and pairing was revoked.",
    });
  });
});
