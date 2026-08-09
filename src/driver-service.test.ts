import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentDriverProcessLock,
  AgentDriverService,
} from "./driver-service.js";

const temporaryRoots: string[] = [];

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "starlight-driver-service-test-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("macOS resident driver service", () => {
  it("returns an honest unsupported result without invoking launchctl", async () => {
    const execute = vi.fn();
    const service = new AgentDriverService({
      platform: "linux",
      homeDirectory: "/home/starlight",
      execFile: execute as never,
    });

    await expect(service.status()).resolves.toMatchObject({
      supported: false,
      installed: false,
      loaded: false,
      running: false,
      lastExitStatus: null,
    });
    await expect(service.install()).rejects.toThrow(/macOS only/u);
    expect(execute).not.toHaveBeenCalled();
  });

  it("installs a minimal restartable LaunchAgent idempotently without provider credentials", async () => {
    const root = await temporaryRoot();
    const cliEntry = join(root, "installed", "starlight-main.js");
    await mkdir(dirname(cliEntry), { recursive: true });
    await writeFile(cliEntry, "#!/usr/bin/env node\n", "utf8");
    let loaded = false;
    let running = false;
    const execute = vi.fn(async (_file: string, args: readonly string[]) => {
      const command = args[0];
      if (command === "print") {
        if (!loaded)
          throw Object.assign(new Error("not loaded"), { code: 113 });
        return {
          stdout: `state = ${running ? "running" : "waiting"}\npid = 731\n`,
          stderr: "",
        };
      }
      if (command === "bootstrap" || command === "kickstart") {
        loaded = true;
        running = true;
        return { stdout: "", stderr: "" };
      }
      if (command === "bootout") {
        loaded = false;
        running = false;
        return { stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected launchctl command ${String(command)}`);
    });
    const service = new AgentDriverService({
      platform: "darwin",
      uid: 501,
      homeDirectory: root,
      nodeExecutable: "/opt/starlight/node",
      cliEntry,
      environment: {
        PATH: "/opt/starlight/bin:/usr/bin:/bin",
        CODEX_HOME: "/tmp/codex-home",
        UNRELATED_SECRET: "must-not-cross",
        ANOTHER_PARENT_VALUE: "must-not-cross",
      },
      execFile: execute as never,
      discoverCodex: async () => "/opt/starlight/bin/codex",
      sleep: async () => undefined,
    });

    await expect(service.install()).resolves.toMatchObject({
      installed: true,
      loaded: true,
      running: true,
    });
    await expect(service.install()).resolves.toMatchObject({
      installed: true,
      loaded: true,
      running: true,
    });

    const contents = await readFile(service.plistPath, "utf8");
    expect(contents).toContain("<string>/opt/starlight/node</string>");
    expect(contents).toContain(`<string>${cliEntry}</string>`);
    expect(contents).toContain("<string>--json</string>");
    expect(contents).toContain("<key>STARLIGHT_CODEX_PATH</key>");
    expect(contents).toContain("<string>/opt/starlight/bin/codex</string>");
    expect(contents).toContain("<key>STARLIGHT_RESIDENT_DRIVER</key>");
    expect(contents).toContain(
      `<key>HOME</key>\n      <string>${root}</string>`,
    );
    expect(contents).not.toContain("STARLIGHT_CREDENTIAL_STORE");
    expect(contents).not.toContain("UNRELATED_SECRET");
    expect(contents).not.toContain("ANOTHER_PARENT_VALUE");
    expect(contents).not.toContain("must-not-cross");
    expect((await stat(service.plistPath)).mode & 0o777).toBe(0o600);
    expect(
      execute.mock.calls.filter(
        ([, args]) => (args as readonly string[])[0] === "bootstrap",
      ),
    ).toHaveLength(1);

    await expect(service.stop()).resolves.toMatchObject({
      installed: true,
      loaded: false,
      running: false,
    });
  });

  it("surfaces the last nonzero LaunchAgent exit as a crash fact", async () => {
    const root = await temporaryRoot();
    const service = new AgentDriverService({
      platform: "darwin",
      uid: 501,
      homeDirectory: root,
      execFile: vi.fn(async () => ({
        stdout: "state = waiting\nlast exit code = 17\n",
        stderr: "",
      })) as never,
    });
    await mkdir(dirname(service.plistPath), { recursive: true });
    await writeFile(service.plistPath, "<plist/>", "utf8");

    await expect(service.status()).resolves.toMatchObject({
      loaded: true,
      running: false,
      pid: null,
      lastExitStatus: 17,
    });
  });
});

describe("resident driver process lock", () => {
  it("rejects a live owner and atomically recovers a stale lock", async () => {
    const root = await temporaryRoot();
    const lockPath = join(root, "driver.lock");
    await mkdir(lockPath, { recursive: true });
    await writeFile(join(lockPath, "pid"), "99\n", "utf8");

    const live = new AgentDriverProcessLock({
      root: lockPath,
      pid: 100,
      processExists: (pid) => pid === 99,
    });
    await expect(live.acquire()).rejects.toThrow(/PID 99/u);

    const stale = new AgentDriverProcessLock({
      root: lockPath,
      pid: 100,
      processExists: () => false,
    });
    await stale.acquire();
    expect(await readFile(lockPath, "utf8")).toBe("100\n");
    await stale.release();
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not remove a fresh ownerless legacy lock or a replacement owner on release", async () => {
    const root = await temporaryRoot();
    const lockPath = join(root, "driver.lock");
    await mkdir(lockPath, { recursive: true });
    const lock = new AgentDriverProcessLock({
      root: lockPath,
      pid: 100,
      processExists: () => false,
      now: Date.now,
    });

    await expect(lock.acquire()).rejects.toThrow(/already starting/u);

    await rm(lockPath, { recursive: true, force: true });
    await lock.acquire();
    await writeFile(lockPath, "101\n", "utf8");
    await lock.release();
    expect(await readFile(lockPath, "utf8")).toBe("101\n");
  });
});
